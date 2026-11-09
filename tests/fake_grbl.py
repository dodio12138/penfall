"""In-memory serial emulator for tests only. Never opens a device."""
import queue
import re
import threading


class FakeGRBL:
    def __init__(self):
        self.responses = queue.Queue()
        self.writes = []
        self.reader_threads = set()
        self.is_open = True
        self.mpos = [-100.0, -150.0, -5.0]
        self.offsets = {f'G{n}': [0.0,0.0,0.0] for n in range(54,60)}
        self.offsets['G54'] = [-100.0,-150.0,-10.0]
        self.g92 = [0.0,0.0,0.0]
        self.tlo = 0.0
        self.wcs = 'G54'
        self.report_inches = False
        self.machine_state = 'Idle'
        self.fail_code = None
        self.drop_code = None
        self.include_wco = True
        self.locked_until_reset = False

    def alarm(self, code, critical=False):
        """Like GRBL: ALARM:n; critical alarms (limits) also require a reset before anything else."""
        self.machine_state = 'Alarm'
        self.emit(f'ALARM:{code}')
        if critical:
            self.locked_until_reset = True
            self.emit('[MSG:Reset to continue]')

    def emit(self, line):
        self.responses.put((line+'\n').encode())

    def wco(self):
        return [self.offsets[self.wcs][i]+self.g92[i]+(self.tlo if i==2 else 0) for i in range(3)]

    def raw(self, values):
        factor = 25.4 if self.report_inches else 1
        return ','.join(f'{v/factor:.6f}' for v in values)

    def write(self, payload):
        if not self.is_open:
            raise OSError('unplugged')
        self.writes.append(payload)
        if payload == b'?':
            self.emit(f'<{self.machine_state}|MPos:{self.raw(self.mpos)}'+(f'|WCO:{self.raw(self.wco())}' if self.include_wco else '')+'|FS:0,0>')
            return
        if payload == b'\x85':
            self.jog_cancels = getattr(self, 'jog_cancels', 0) + 1
            if self.machine_state == 'Jog':
                self.machine_state = 'Idle'
            return
        if payload == b'!':
            self.machine_state='Hold:0'
            return
        if payload == b'~':
            self.machine_state='Idle'
            return
        if payload == b'\x18':
            self.locked_until_reset = False
            self.emit("Grbl 1.1h ['$' for help]")
            if self.machine_state == 'Alarm':
                self.emit("[MSG:'$H'|'$X' to unlock]")
            return
        if self.locked_until_reset:
            return  # critical alarm: GRBL ignores commands until reset
        code = payload.decode().strip()
        if code == '$X':
            if self.machine_state == 'Alarm':
                self.machine_state = 'Idle'
                self.emit('[MSG:Caution: Unlocked]')
            self.emit('ok')
            return
        if self.machine_state == 'Alarm' and not code.startswith('$'):
            self.emit('error:9')
            return
        if code == self.drop_code:
            return
        if code == self.fail_code:
            self.emit('error:20')
            return
        if code == '$$':
            for line in [f'$13={int(self.report_inches)}','$22=1','$130=300','$131=300','$132=30']:
                self.emit(line)
        elif code == '$G':
            self.emit(f'[GC:G0 {self.wcs} G17 G21 G90 G94 M5 M9 T0 S0 F100]')
        elif code == '$#':
            for name,values in self.offsets.items():
                self.emit(f'[{name}:{self.raw(values)}]')
            self.emit(f'[G92:{self.raw(self.g92)}]')
            self.emit(f'[TLO:{self.tlo/(25.4 if self.report_inches else 1):.6f}]')
        elif re.fullmatch(r'G5[4-9]',code):
            self.wcs=code
        elif code.startswith('G10 L20 P'):
            p=int(re.search(r'P(\d+)',code)[1])
            target=f'G{53+p}'
            for axis,number in re.findall(r'([XYZ])([+-]?[\d.]+)',code):
                i='XYZ'.index(axis)
                self.offsets[target][i]=self.mpos[i]-self.g92[i]-(self.tlo if i==2 else 0)-float(number)
        elif code.startswith('$J='):
            # Jog: relative mm move, applied at once (the emulator does not model motion time).
            if not re.fullmatch(r'\$J=G91 G21 [XYZ][+-]?[\d.]+ F[\d.]+', code):
                self.emit('error:3')
                return
            axis, number = re.search(r'([XYZ])([+-]?[\d.]+)', code[9:]).groups()
            if abs(float(number)) > 200:
                self.emit('error:15')
                return
            self.mpos['XYZ'.index(axis)] += float(number)
        elif re.match(r'^G[01](?:\s|$)',code):
            for axis,number in re.findall(r'([XYZ])([+-]?[\d.]+)',code):
                i='XYZ'.index(axis)
                self.mpos[i]=float(number)+self.wco()[i]
        self.emit('ok')

    def readline(self):
        self.reader_threads.add(threading.get_ident())
        if not self.is_open:
            raise OSError('closed')
        try:
            return self.responses.get(timeout=.02)
        except queue.Empty:
            return b''

    def close(self):
        self.is_open=False
