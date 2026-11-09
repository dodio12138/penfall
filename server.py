#!/usr/bin/env python3
"""Same-origin UI + authenticated GRBL 1.1 bridge. Never expose to the Internet."""
import argparse
import json
import math
import re
import secrets
import socket
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from grbl import ProtocolError, Session

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None

ROOT = Path(__file__).resolve().parent / 'web'
STATIC_TYPES = {'.html', '.css', '.js', '.svg', '.gcode', '.ico', '.png'}


def static_assets(root=ROOT):
    """Whitelist of public files: everything under web/ with a known type, no dotfiles."""
    assets = {'/'}
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if path.is_file() and path.suffix in STATIC_TYPES and not any(part.startswith('.') for part in relative.parts):
            assets.add('/' + relative.as_posix())
    return frozenset(assets)


ASSETS = static_assets()
TOKEN = secrets.token_urlsafe(24)
SESSION = None
WORKER = None
LOCK = threading.RLock()
CONTROL_LOCK = threading.Lock()
CANCEL = threading.Event()
PAUSE = threading.Event()
STATE = dict(connected=False, state='disconnected', ack=0, total=0, message='未连接', port='', job_id='')


def update(**values):
    with LOCK:
        STATE.update(values)


def snapshot():
    with LOCK:
        result = dict(STATE)
    session = SESSION
    result['portOpen'] = session is not None and session.alive
    result['coordinates'] = session.snapshot() if session else None
    if session and session.fault:
        result.update(connected=False, message=session.fault)
        if result['state'] not in ('stopped', 'error'):
            result['state'] = 'error'
    return result


def validate_job(lines, limits):
    if not isinstance(lines, list) or not 1 <= len(lines) <= 20000:
        raise ValueError('程序必须为 1–20000 行')
    lowz, highz, maxx, maxy = [float(limits[k]) for k in ('zmin', 'zmax', 'x', 'y')]
    if not all(map(math.isfinite, (lowz, highz, maxx, maxy))) or not (-200 <= lowz < highz <= 200 and 0 < maxx <= 2000 and 0 < maxy <= 2000):
        raise ValueError('纸张坐标范围无效')
    mm = absolute = feed_known = False
    motion_mode = 0
    commands = []
    for raw in lines:
        if not isinstance(raw, str) or len(raw) > 120:
            raise ValueError('单行过长或格式错误')
        code = raw.strip().upper()
        tokens = re.findall(r'([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))', code)
        if not tokens or re.sub(r'([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))', '', code).strip():
            raise ValueError('非法指令')
        seen = set()
        for letter, number in tokens:
            value = float(number)
            if not math.isfinite(value):
                raise ValueError('非有限坐标')
            if letter in seen:
                raise ValueError('真实发送要求每行每类字仅出现一次；请分行书写')
            seen.add(letter)
            if letter == 'G':
                if value not in (0, 1, 17, 21, 90):
                    raise ValueError('真实发送暂限 G0/G1、G17、G21、G90；其他代码请先转换为绝对毫米直线')
                if value in (0, 1):
                    motion_mode = int(value)
                mm = mm or value == 21
                absolute = absolute or value == 90
            elif letter in 'XYZ':
                if not mm or not absolute:
                    raise ValueError('运动前必须分别声明 G21 和 G90')
                lower, upper = (lowz, highz) if letter == 'Z' else (0, maxx if letter == 'X' else maxy)
                if not lower <= value <= upper:
                    raise ValueError(f'{letter}={value} 超出确认的纸张坐标范围')
            elif letter == 'F':
                if not 0 < value <= 10000:
                    raise ValueError('速度超出 0–10000 mm/min')
                feed_known = True
            else:
                raise ValueError('任务不接受坐标设置、回零、M/S/N 或其他指令')
        if motion_mode == 1 and any(letter in 'XYZ' for letter, _ in tokens) and not feed_known:
            raise ValueError('首次 G1 运动前必须显式声明 F，不能沿用未知进给速度')
        commands.append(' '.join(letter + number for letter, number in tokens))
    if not mm or not absolute:
        raise ValueError('程序缺少 G21 / G90')
    return commands


def validate_machine_path(lines, coordinates, limits):
    """Absolute straight-line endpoints and the real starting position in machine frame."""
    bounds = {}
    for axis in 'xyz':
        low, high = float(limits[axis+'min']), float(limits[axis+'max'])
        if not math.isfinite(low) or not math.isfinite(high) or not -10000 <= low < high <= 10000:
            raise ValueError('必须填写并核对机器 XYZ 最小 / 最大行程坐标')
        bounds[axis] = (low, high)
    if not coordinates['ready'] or coordinates['mpos'] is None or coordinates['wpos'] is None:
        raise ValueError('缺少可信的机器坐标')
    def check(position):
        for i, axis in enumerate('xyz'):
            low, high = bounds[axis]
            if not low - .0005 <= position[i] <= high + .0005:
                raise ValueError(f'机器 {axis.upper()}={position[i]:.3f} 超出确认的机器行程 [{low}, {high}]')
    check(coordinates['mpos'])
    work = list(coordinates['wpos'])
    for line in lines:
        words = dict(re.findall(r'([XYZ])([+-]?(?:\d+(?:\.\d*)?|\.\d+))', line))
        for i, axis in enumerate('XYZ'):
            if axis in words:
                work[i] = float(words[axis])
        check([value + coordinates['wco'][i] for i, value in enumerate(work)])


def ensure_task_frame(session, frame):
    if session.fault:
        raise ProtocolError(session.fault)
    current = session.snapshot()
    if not current['fresh'] or current['machineState'].split(':')[0] not in ('Idle', 'Run', 'Hold') or any(current[key] != frame[key] for key in ('wcs', 'wco', 'g92', 'tlo', 'reportUnits')):
        session._fail('任务坐标基准改变或位置报告失效，停止追加指令，请检查机器后重新连接')
        raise ProtocolError(session.fault)


def execute(session, lines, wcs, frame=None):
    # The handler reserves the operation lock before preflight; only this worker releases it.
    try:
        frame = frame or session.snapshot()
        for code in ('G21', 'G90', 'G17', 'G94', 'G0', wcs):
            if CANCEL.is_set():
                return
            ensure_task_frame(session, frame)
            session.command(code)
        for index, line in enumerate(lines):
            while PAUSE.is_set() and not CANCEL.is_set():
                ensure_task_frame(session, frame)
                time.sleep(.05)
            if CANCEL.is_set():
                return
            ensure_task_frame(session, frame)
            session.command(line, timeout=30)
            update(ack=index+1)
        deadline = time.monotonic()+600
        while time.monotonic() < deadline and not CANCEL.is_set():
            with LOCK:
                if CANCEL.is_set():
                    return
                update(state='paused' if PAUSE.is_set() else 'draining', message='已请求 Feed Hold' if PAUSE.is_set() else '指令已确认，等待控制器 Idle')
            coordinates = session.status(timeout=2)
            ensure_task_frame(session, frame)
            if coordinates['machineState'] == 'Idle':
                with LOCK:
                    if not CANCEL.is_set():
                        update(state='complete', message='控制器已报告 Idle')
                return
            if coordinates['machineState'] in ('Alarm', 'Door', 'Sleep'):
                raise ProtocolError('设备处于异常或不可继续状态')
            time.sleep(.15)
        if not CANCEL.is_set():
            raise ProtocolError('等待 Idle 超时')
    except Exception as error:
        if not CANCEL.is_set():
            try:
                session.realtime(b'!')
            except Exception:
                pass
            update(state='error', message=str(error))
    finally:
        session.operation_kind = None
        session.operation.release()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        # Status polling runs several times per second; only log other requests and failures.
        if self.path.startswith('/api/status') and len(args) > 1 and str(args[1]) == '200':
            return
        super().log_message(format, *args)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        if self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        else:
            # Always revalidate: a stale cached script mixed with new HTML breaks the shared globals.
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def reply(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self):
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            self.reply({'error': '拒绝跨来源访问'}, 403)
            return False
        if not secrets.compare_digest(self.headers.get('X-Bridge-Key', '').encode(), TOKEN.encode()):
            self.reply({'error': '访问密钥无效，请使用服务启动时显示的密钥'}, 401)
            return False
        return True

    def do_HEAD(self):
        # The base class would answer HEAD for any file under ROOT; apply the same whitelist.
        if self.path.split('?', 1)[0] not in ASSETS:
            self.send_error(404)
            return
        return super().do_HEAD()

    def do_GET(self):
        if not self.path.startswith('/api/'):
            if self.path.split('?', 1)[0] not in ASSETS:
                self.send_error(404)
                return
            return super().do_GET()
        if not self.authorized():
            return
        if self.path == '/api/status':
            self.reply(snapshot())
        elif self.path == '/api/ports':
            if serial is None:
                self.reply({'error': 'USB 依赖未安装：python3 -m pip install -r requirements.txt'}, 503)
            else:
                self.reply({'ports': [{'path': p.device, 'name': p.description} for p in list_ports.comports()]})
        else:
            self.reply({'error': '未知接口'}, 404)

    def do_POST(self):
        global SESSION, WORKER
        if not self.path.startswith('/api/') or not self.authorized():
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 2_000_000:
                raise ValueError('请求长度无效')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('请求必须是对象')
            with CONTROL_LOCK:
                live = WORKER is not None and WORKER.is_alive()
                if self.path == '/api/connect':
                    if serial is None:
                        raise ValueError('请先安装 requirements.txt 中的 pyserial')
                    if SESSION is not None or live:
                        raise ValueError('请先停止任务并断开当前串口')
                    if data.get('confirm') is not True:
                        raise ValueError('必须先确认 GRBL 协议')
                    ports = {p.device for p in list_ports.comports()}
                    baud = int(data.get('baud', 0))
                    if data.get('port') not in ports or baud not in (9600, 57600, 115200, 250000):
                        raise ValueError('串口或波特率无效')
                    board = serial.Serial(data['port'], baud, timeout=.1, write_timeout=2, exclusive=True)
                    session = None
                    try:
                        deadline, version = time.monotonic()+3, None
                        while time.monotonic() < deadline:
                            line = board.readline().decode('ascii', errors='replace')
                            match = re.match(r'^Grbl (\S+)', line)
                            if match:
                                version = match[1]
                                break
                        if not version or not version.startswith('1.1'):
                            raise ValueError('未检测到标准 GRBL 1.1 标识，拒绝连接；请核实固件')
                        session = Session(board, version)
                        message = 'GRBL 1.1 已连接'
                        try:
                            with session.reserve('sync'):
                                session.refresh()
                        except ProtocolError as error:
                            if session.fault:
                                raise
                            message = f'已连接，但坐标未就绪：{error}'
                        session.start_polling()
                    except Exception:
                        if session:
                            session.close()
                        else:
                            board.close()
                        raise
                    SESSION = session
                    update(connected=True, state='idle', port=data['port'], message=message, ack=0, total=0, job_id='')
                elif self.path == '/api/disconnect':
                    if live:
                        raise ValueError('任务线程仍在运行，请先停止后再断开')
                    if SESSION:
                        SESSION.close()
                    SESSION = None
                    update(connected=False, state='disconnected', message='已断开')
                elif self.path == '/api/coordinates/refresh':
                    if SESSION is None or live:
                        raise ValueError('未连接或有任务运行')
                    with SESSION.reserve('sync', timeout=1):
                        SESSION.refresh()
                    update(message='坐标已从控制器读回')
                elif self.path in ('/api/coordinates/wcs', '/api/coordinates/zero'):
                    if SESSION is None or live:
                        raise ValueError('未连接或有任务运行，不能修改坐标')
                    if data.get('reviewed') is not True:
                        raise ValueError('必须确认坐标操作')
                    action = self.path.rsplit('/', 1)[1]
                    SESSION.coordinate_action(action, data.get('expected'), target=data.get('wcs'), axes=data.get('axes'))
                    update(message='工件坐标系已读回确认' if action == 'wcs' else '纸张 X/Y 设零已读回确认')
                elif self.path == '/api/job':
                    if SESSION is None or live:
                        raise ValueError('未连接或已有任务运行')
                    if data.get('reviewed') is not True:
                        raise ValueError('必须确认纸张、机器行程和抬落笔协议')
                    session = SESSION
                    if not session.operation.acquire(timeout=1):
                        raise ValueError('控制器正在同步，请稍后重试')
                    session.operation_kind = 'job'
                    handed_off = False
                    try:
                        coordinates = session.refresh()
                        if not coordinates['idle']:
                            raise ValueError('控制器不是 Idle，拒绝任务')
                        if not data.get('expected') or data['expected'] != coordinates['token']:
                            raise ValueError('坐标或位置已改变，请重新确认后发送')
                        lines = validate_job(data.get('lines'), data.get('limits', {}))
                        validate_machine_path(lines, coordinates, data.get('machine', {}))
                        CANCEL.clear()
                        PAUSE.clear()
                        update(state='running', ack=0, total=len(lines), job_id=secrets.token_hex(8), wcs=coordinates['wcs'], message=f"正在发送 · {coordinates['wcs']}")
                        session.task_frame = coordinates
                        WORKER = threading.Thread(target=execute, args=(session, lines, coordinates['wcs'], coordinates), daemon=True)
                        WORKER.start()
                        handed_off = True
                    finally:
                        if not handed_off:
                            session.operation_kind = None
                            session.operation.release()
                elif self.path in ('/api/pause', '/api/resume', '/api/stop'):
                    with LOCK:
                        if SESSION is None or not live or STATE['state'] not in ('running', 'paused', 'draining'):
                            raise ValueError('当前没有可控制的硬件任务')
                        if self.path.endswith('pause'):
                            PAUSE.set()
                            SESSION.realtime(b'!')
                            update(state='paused', message='已请求 Feed Hold')
                        elif self.path.endswith('resume'):
                            ensure_task_frame(SESSION, SESSION.task_frame)
                            SESSION.realtime(b'~')
                            PAUSE.clear()
                            update(state='running', message='已请求 Cycle Start')
                        else:
                            CANCEL.set()
                            PAUSE.clear()
                            SESSION._fail('已请求软复位，坐标已失效；请检查机器后重新连接')
                            SESSION.realtime(b'\x18')
                            update(state='stopped', message='已请求软复位，不等于物理急停')
                else:
                    self.reply({'error': '未知接口'}, 404)
                    return
            self.reply(snapshot())
        except (ValueError, KeyError, TypeError, OSError, ProtocolError) as error:
            self.reply({'error': str(error), 'status': snapshot()}, 400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1', help='局域网访问显式指定 0.0.0.0')
    parser.add_argument('--port', default=5173, type=int)
    args = parser.parse_args()
    print(f'Web UI: http://{"localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host}:{args.port}', flush=True)
    if args.host == '0.0.0.0':
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(('192.0.2.1', 9))  # No packets are sent; only picks the LAN interface.
                print(f'局域网访问: http://{probe.getsockname()[0]}:{args.port}', flush=True)
        except OSError:
            pass
    print(f'桥接访问密钥: {TOKEN}', flush=True)
    print('仅用于可信局域网；HTTP 不加密，不要映射到公网。', flush=True)
    if serial is None:
        print('未安装 pyserial，USB 接口暂不可用。', flush=True)
    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止。', flush=True)
        if SESSION:
            SESSION.close()
