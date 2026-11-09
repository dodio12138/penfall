"""Conservative GRBL 1.1 telemetry/transactions. Only the reader thread reads USB."""
import contextlib
import hashlib
import json
import math
import re
import secrets
import threading
import time


class ProtocolError(RuntimeError):
    pass


def vector(text):
    try:
        values = [float(v) for v in text.split(',')]
    except ValueError:
        raise ProtocolError('无效坐标报告')
    if len(values) != 3 or not all(math.isfinite(v) and abs(v) <= 1e7 for v in values):
        raise ProtocolError('仅支持有限 XYZ 三轴报告')
    return values


class Coordinates:
    """Unknown is None, never invented zero. Store raw report units until $13 is known."""
    def __init__(self, version='1.1', clock=time.monotonic):
        self.clock = clock
        self.version = version
        self.session_id = secrets.token_hex(12)
        self.reset()

    def reset(self):
        self.session_id = secrets.token_hex(12)
        self.machine_state = None
        self.mpos = self.wpos = self.wco = None
        self.position_time = self.status_time = self.modal_time = None
        self.wcs = self.units = self.distance = self.feed_mode = None
        self.report_inches = None
        self.offsets = {}
        self.g92 = self.tlo = None
        self.settings = {}
        self.fault = None
        self.sequence = 0

    def invalidate_offsets(self):
        self.mpos = self.wpos = self.wco = None
        self.position_time = self.modal_time = None
        self.wcs = None
        self.offsets = {}
        self.g92 = self.tlo = None
        self.sequence += 1

    def feed(self, line):
        now = self.clock()
        if line.startswith('Grbl '):
            self.reset()
            self.fault = '控制器复位，坐标已失效，请重新连接'
            return
        if line.startswith('ALARM:'):
            self.invalidate_offsets()
            self.machine_state = 'Alarm'
            self.status_time = now
            self.fault = line
            return
        if line.startswith('<') and line.endswith('>'):
            fields = line[1:-1].split('|')
            if not re.fullmatch(r'(Idle|Run|Hold|Jog|Alarm|Door|Check|Home|Sleep)(:\d+)?', fields[0]):
                raise ProtocolError('不支持的状态报告格式，需要标准 GRBL 1.1')
            values = dict(field.split(':', 1) for field in fields[1:] if ':' in field)
            parsed = {key: vector(values[key]) for key in ('MPos', 'WPos', 'WCO') if key in values}
            self.machine_state = fields[0]
            self.status_time = now
            if 'WCO' in parsed:
                self.wco = parsed['WCO']
            if 'MPos' in parsed or 'WPos' in parsed:
                # Do not combine a previous report's position with a new report's position.
                self.mpos = parsed.get('MPos')
                self.wpos = parsed.get('WPos')
                self.position_time = now
            self.sequence += 1
            return
        match = re.fullmatch(r'\$(\d+)=([+-]?(?:\d+(?:\.\d*)?|\.\d+))', line)
        if match:
            key, value = int(match[1]), float(match[2])
            if not math.isfinite(value):
                raise ProtocolError('无效固件设置')
            self.settings[key] = value
            if key == 13:
                if value not in (0, 1):
                    raise ProtocolError('未知位置报告单位')
                if self.report_inches is not None and self.report_inches != bool(value):
                    self.invalidate_offsets()
                self.report_inches = bool(value)
            return
        if line.startswith('[GC:') and line.endswith(']'):
            modes = line[4:-1].split()
            self.wcs = next((v for v in modes if v in ('G54', 'G55', 'G56', 'G57', 'G58', 'G59')), None)
            self.units = next((v for v in modes if v in ('G20', 'G21')), None)
            self.distance = next((v for v in modes if v in ('G90', 'G91')), None)
            self.feed_mode = next((v for v in modes if v in ('G93', 'G94')), None)
            self.modal_time = now
            return
        match = re.fullmatch(r'\[(G5[4-9]|G92|TLO):(.+)\]', line)
        if match:
            key, text = match.groups()
            if key == 'TLO':
                value = float(text)
                if not math.isfinite(value):
                    raise ProtocolError('无效刀长补偿')
                self.tlo = value
            elif key == 'G92':
                self.g92 = vector(text)
            else:
                self.offsets[key] = vector(text)

    def snapshot(self):
        now = self.clock()
        age = None if self.position_time is None else max(0, now - self.position_time)
        fresh = age is not None and age <= 2.5 and not self.fault
        factor = None if self.report_inches is None else 25.4 if self.report_inches else 1
        convert = lambda v: None if v is None or factor is None else [round(x * factor, 6) for x in v]
        mpos, wpos, wco = convert(self.mpos), convert(self.wpos), convert(self.wco)
        if wco is not None:
            if mpos is not None and wpos is None:
                wpos = [round(a - b, 6) for a, b in zip(mpos, wco)]
            elif wpos is not None and mpos is None:
                mpos = [round(a + b, 6) for a, b in zip(wpos, wco)]
        offsets = {key: convert(value) for key, value in self.offsets.items()}
        g92 = convert(self.g92)
        tlo = None if self.tlo is None or factor is None else round(self.tlo * factor, 6)
        consistent = mpos is not None and wpos is not None and wco is not None and all(abs(a-b-c) <= .02 for a,b,c in zip(mpos,wpos,wco))
        modal_fresh = self.modal_time is not None and now - self.modal_time <= 10
        supported = self.version.startswith('1.1')
        parameters_known = self.wcs in offsets and g92 is not None and tlo is not None
        parameter_match = bool(parameters_known and wco is not None and all(abs(a - b - c - (tlo if i == 2 else 0)) <= .02 for i,(a,b,c) in enumerate(zip(wco,offsets[self.wcs],g92))))
        ready = bool(supported and fresh and consistent and modal_fresh and self.wcs and factor is not None and parameter_match)
        if self.fault:
            reason = self.fault
        elif not supported:
            reason = '坐标操作仅支持已确认的标准 GRBL 1.1'
        elif not fresh:
            reason = '位置报告未知或已过期'
        elif factor is None:
            reason = '位置报告单位未知'
        elif not consistent:
            reason = '缺少一致的机器 / 工件位置与 WCO'
        elif not modal_fresh or not self.wcs:
            reason = '活动坐标系尚未读回或已过期'
        elif not ready:
            reason = '坐标偏移参数未读全或 WCO 尚未同步'
        else:
            reason = ''
        frame = [self.session_id, self.wcs, wco, g92, tlo, self.report_inches]
        digest = lambda data: hashlib.sha256(json.dumps(data, separators=(',', ':')).encode()).hexdigest()[:24]
        frame_token = digest(frame) if ready else None
        token = digest([frame, mpos]) if ready else None
        return dict(source='controller', units='mm' if factor is not None else None,
                    machineState=self.machine_state, ageMs=None if age is None else round(age*1000),
                    fresh=fresh, ready=ready, idle=self.machine_state == 'Idle', reason=reason,
                    mpos=mpos if fresh else None, wpos=wpos if fresh else None,
                    wco=wco if not self.fault else None, wcs=self.wcs,
                    g92=g92, tlo=tlo, offsets=offsets, token=token, frameToken=frame_token,
                    reportUnits=None if factor is None else 'inch' if self.report_inches else 'mm',
                    modal=dict(units=self.units, distance=self.distance, feed=self.feed_mode),
                    homingEnabled=None if 22 not in self.settings else bool(self.settings[22]),
                    travel=[self.settings.get(key) for key in (130,131,132)])


class Session:
    def __init__(self, board, version='1.1'):
        self.board = board
        self.model = Coordinates(version)
        self.condition = threading.Condition(threading.RLock())
        self.write_lock = threading.Lock()
        self.command_lock = threading.Lock()
        self.operation = threading.Lock()
        self.operation_kind = None
        self.task_frame = None
        self.pending = None
        self.alive = True
        self.fault = None
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.poller = threading.Thread(target=self._poll, daemon=True)
        self.reader.start()

    def _fail(self, message):
        with self.condition:
            self.fault = message
            self.model.fault = message
            if self.pending is not None:
                self.pending['error'] = message
                self.pending['done'] = True
            self.condition.notify_all()

    def _read(self):
        buffer = b''
        try:
            while self.alive:
                chunk = self.board.readline()
                if not chunk:
                    continue
                buffer += chunk
                if len(buffer) > 16384:
                    raise ProtocolError('串口报告超出长度上限')
                while b'\n' in buffer:
                    raw, _, buffer = buffer.partition(b'\n')
                    line = raw.decode('ascii', errors='replace').strip()
                    if not line:
                        continue
                    with self.condition:
                        self.model.feed(line)
                        if line.startswith(('Grbl ', 'ALARM:')):
                            self._fail(self.model.fault)
                        if self.pending is not None and not self.pending['done']:
                            if line == 'ok':
                                self.pending['done'] = True
                            elif line.lower().startswith('error:'):
                                self.pending.update(done=True, error=line)
                        self.condition.notify_all()
        except Exception as error:
            if self.alive:
                self._fail(f'串口读取失败：{error}')

    def realtime(self, payload):
        if not self.alive:
            raise ProtocolError('串口已关闭')
        with self.write_lock:
            self.board.write(payload)

    def command(self, code, timeout=3):
        if '\n' in code or '\r' in code:
            raise ProtocolError('不允许多行串口事务')
        with self.command_lock:
            with self.condition:
                if self.fault or not self.alive:
                    raise ProtocolError(self.fault or '串口已关闭')
                pending = dict(done=False, error=None)
                self.pending = pending
                try:
                    try:
                        self.realtime((code + '\n').encode('ascii'))
                    except Exception as error:
                        self._fail(f'串口写入失败，状态未知，请重新连接：{error}')
                        raise ProtocolError(self.fault)
                    deadline = time.monotonic() + timeout
                    while not pending['done'] and self.alive:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            # A late ok must not be assigned to a subsequent command.
                            self._fail('控制器应答超时，事务状态未知，请重新连接')
                            break
                        self.condition.wait(remaining)
                    if pending['error'] or not pending['done']:
                        raise ProtocolError(pending['error'] or '串口已关闭')
                finally:
                    self.pending = None

    def status(self, timeout=2, require_ready=False):
        deadline = time.monotonic() + timeout
        with self.condition:
            sequence = self.model.sequence
        while time.monotonic() < deadline:
            self.realtime(b'?')
            with self.condition:
                self.condition.wait_for(lambda: self.model.sequence > sequence or self.fault, timeout=.15)
                if self.fault:
                    raise ProtocolError(self.fault)
                result = self.model.snapshot()
                if self.model.sequence > sequence and (result['ready'] or not require_ready):
                    return result
                sequence = self.model.sequence
        raise ProtocolError('坐标报告不完整或等待超时')

    def refresh(self):
        for query in ('$$', '$G', '$#'):
            self.command(query, timeout=2)
        return self.status(timeout=3, require_ready=True)

    def snapshot(self):
        with self.condition:
            result = self.model.snapshot()
            result['operation'] = self.operation_kind
            if self.fault:
                result.update(ready=False, token=None, frameToken=None, reason=self.fault, mpos=None, wpos=None, fresh=False)
            return result

    @contextlib.contextmanager
    def reserve(self, kind, timeout=0):
        if not self.operation.acquire(timeout=timeout):
            raise ProtocolError('控制器有任务或正在同步，请稍后重试')
        self.operation_kind = kind
        try:
            if self.fault:
                raise ProtocolError(self.fault)
            yield
        finally:
            self.operation_kind = None
            self.operation.release()

    def coordinate_action(self, action, expected, target=None, axes=None):
        with self.reserve('coordinate', timeout=1):
            before = self.refresh()
            if not before['idle']:
                raise ProtocolError('控制器不是 Idle，禁止修改坐标')
            if not expected or expected != before['token']:
                raise ProtocolError('坐标或位置已改变，请刷新并重新确认')
            if action == 'wcs':
                if target not in ('G54','G55','G56','G57','G58','G59'):
                    raise ProtocolError('不支持的工件坐标系')
                code = target
            elif action == 'zero':
                if axes not in ('X','Y','XY'):
                    raise ProtocolError('仅允许设置纸张 X/Y 零点，不修改 Z')
                p = int(before['wcs'][1:]) - 53
                code = f'G10 L20 P{p} ' + ' '.join(axis+'0' for axis in axes)
            else:
                raise ProtocolError('不支持的坐标操作')
            with self.condition:
                current = self.model.snapshot()
                if not current['ready'] or not current['idle'] or current['token'] != before['token']:
                    raise ProtocolError('写入前坐标或运动状态已变化，拒绝操作')
                self.model.invalidate_offsets()
            self.command(code)
            after = self.refresh()
            if not after['idle'] or any(abs(a-b) > .02 for a,b in zip(before['mpos'],after['mpos'])):
                self._fail('设零 / 切换期间位置发生变化，状态不可信，请检查机器后重新连接')
                raise ProtocolError(self.fault)
            if action == 'wcs' and after['wcs'] != target:
                raise ProtocolError('坐标系切换未获读回确认')
            if action == 'zero':
                if after['wcs'] != before['wcs'] or any(abs(after['wpos']['XYZ'.index(axis)]) > .02 for axis in axes):
                    raise ProtocolError('纸张设零未获读回确认')
            return after

    def _poll(self):
        last_modal = time.monotonic()
        while self.alive:
            try:
                self.realtime(b'?')
                if not self.fault and time.monotonic() - last_modal >= 3 and self.operation.acquire(blocking=False):
                    try:
                        self.operation_kind = 'poll'
                        self.command('$G', timeout=2)
                        last_modal = time.monotonic()
                    finally:
                        self.operation_kind = None
                        self.operation.release()
            except Exception as error:
                if self.alive:
                    self._fail(str(error))
            time.sleep(.25)

    def start_polling(self):
        self.poller.start()

    def close(self):
        self.alive = False
        self._fail('串口已关闭')
        self.board.close()
        self.reader.join(timeout=1)
        if self.poller.is_alive():
            self.poller.join(timeout=1)
