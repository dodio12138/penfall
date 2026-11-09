import contextlib
import importlib.util
import json
import pathlib
import threading
import time
import urllib.error
import urllib.request
import unittest
from grbl import Session
from fake_grbl import FakeGRBL

spec = importlib.util.spec_from_file_location('bridge', pathlib.Path(__file__).resolve().parents[1] / 'server.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
LIMITS = dict(x=210, y=297, zmin=0, zmax=10)
MACHINE = dict(xmin=-300,xmax=0,ymin=-300,ymax=0,zmin=-30,zmax=0)


class BridgeValidation(unittest.TestCase):
    def test_identify_grbl_by_banner_or_read_only_query(self):
        class Board:
            def __init__(self, banner=(), answers=None):
                self.lines, self.answers, self.sent = [line + '\n' for line in banner], answers or {}, b''
            def readline(self):
                if self.lines:
                    return self.lines.pop(0).encode()
                time.sleep(.005)
                return b''
            def write(self, data):
                self.sent += data
                for key, lines in self.answers.items():
                    if key in data:
                        self.lines += [line + '\n' for line in lines]
            def reset_input_buffer(self):
                self.lines = []
        banner = Board(["Grbl 1.1h ['$' for help]"])
        self.assertEqual(bridge.identify_grbl(banner, .1, .1), '1.1h')
        self.assertEqual(banner.sent, b'', 'nothing is sent when the banner arrives')
        quiet = Board(answers={b'$I': ['[VER:1.1f.20170801:]', '[OPT:V,15,128]', 'ok']})
        self.assertEqual(bridge.identify_grbl(quiet, .1, .1), '1.1f')
        self.assertEqual(quiet.sent, b'\r\n$I\n', 'only the read-only $I query')
        self.assertEqual(quiet.lines, [], 'the rest of the $I answer is dropped')
        esp32 = Board(answers={b'$I': ['ok', 'ok', '[VER:1.3a.20221201:]', 'ok']})
        self.assertEqual(bridge.identify_grbl(esp32, .1, .1), '1.3a', 'Grbl_Esp32 reports 1.3a and speaks the 1.1 protocol')
        for board, reason in [(Board(), '没有任何回应'), (Board(['Grbl 0.9j']), '0.9j'), (Board(answers={b'$I': ['[VER:1.2b.20200101:]']}), '1.2b'), (Board(answers={b'$I': ['echo:Unknown command']}), 'Unknown command')]:
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                bridge.identify_grbl(board, .1, .1)

    def test_servo_profile_allows_only_its_pen_commands(self):
        pen = dict(mode='servo-m5', down=30, dwell=.15)
        lines = ['G21', 'G90', 'M5', 'G4 P0.15', 'G0 X1 Y1', 'M3 S30', 'G4 P0.15', 'G1 X2 Y2 F1200', 'M5']
        self.assertEqual(bridge.validate_job(lines, LIMITS, pen), lines)
        for line in ['M3 S100', 'M3', 'S30', 'M3 S30 X1', 'G4 P9', 'G4 P1 X1', 'G1 X1 P1', 'M8']:
            with self.subTest(line=line), self.assertRaises(ValueError):
                bridge.validate_job(['G21', 'G90', line], LIMITS, pen)
        with self.assertRaises(ValueError):
            bridge.validate_job(['G21', 'G90', 'M5'], LIMITS)
        two = dict(mode='servo-s', down=30, up=90)
        self.assertEqual(len(bridge.validate_job(['G21', 'G90', 'M3 S90', 'M3 S30'], LIMITS, two)), 4)
        for bad in [dict(mode='laser', down=1), dict(mode='servo-s', down=30, up=30), dict(mode='servo-m5', down=-1), dict(mode='servo-m5', down=30, dwell=9), dict(mode='servo-m5', down=True)]:
            with self.subTest(pen=bad), self.assertRaises(ValueError):
                bridge.validate_job(['G21', 'G90'], LIMITS, bad)

    def test_generated_subset(self):
        lines=['G21','G90','G17','G0 Z5','G0 X20 Y20','G1 Z0 F300','G1 X40 Y40 F1200','G0 Z5']
        self.assertEqual(len(bridge.validate_job(lines,LIMITS)),len(lines))

    def test_rejects_unsafe_or_unsupported(self):
        for line in ['G0 X211','G0 Y-1','G0 Z11','G1 F0','G91','G20','M3 S100','G28','$H','G92 X0','G1 X1 X2','G2 X10 I5','G1 X1\nG0 X2']:
            with self.subTest(line=line),self.assertRaises(ValueError):
                bridge.validate_job(['G21','G90',line],LIMITS)

    def test_rejects_implicit_units_and_positioning(self):
        for lines in [['G0 X10'],['G21','G0 X10'],['G90','G0 X10']]:
            with self.assertRaises(ValueError):
                bridge.validate_job(lines,LIMITS)

    def test_linear_feed_cannot_be_inherited_from_unknown_controller_state(self):
        for lines in [['G21','G90','G1 X10'],['G21','G90','G1','X10']]:
            with self.assertRaisesRegex(ValueError,'显式声明 F'):
                bridge.validate_job(lines,LIMITS)
        bridge.validate_job(['G21','G90','G1 X10 F500','Y20'],LIMITS)

    def test_acknowledgement_and_idle(self):
        board=FakeGRBL();session=Session(board)
        try:
            session.refresh();board.writes.clear()
            session.operation.acquire();session.operation_kind='job'
            bridge.CANCEL.clear();bridge.PAUSE.clear()
            bridge.execute(session,['G21','G90','G0 Z5'],'G54')
            self.assertEqual(bridge.snapshot()['state'],'complete')
            self.assertEqual(bridge.snapshot()['ack'],3)
            self.assertIn(b'G94\n',board.writes)
            self.assertIn(b'G54\n',board.writes)
            self.assertFalse(session.operation.locked())
        finally:
            session.close()

    def test_controller_error_stops_queue_and_requests_feed_hold(self):
        board=FakeGRBL();session=Session(board)
        try:
            session.refresh();board.writes.clear();board.fail_code='G21'
            session.operation.acquire();bridge.CANCEL.clear()
            bridge.execute(session,['G21','G90','G0 X10'],'G54')
            self.assertEqual(bridge.snapshot()['state'],'error')
            self.assertNotIn(b'G90\n',board.writes)
            self.assertEqual(board.writes[-1],b'!')
        finally:
            session.close()

    def test_changed_task_frame_is_quarantined_before_more_motion(self):
        board=FakeGRBL();session=Session(board)
        try:
            frame=session.refresh();board.writes.clear()
            with session.condition:
                session.model.feed('<Idle|MPos:-100,-150,-5|WCO:-90,-150,-10>')
            session.operation.acquire();bridge.CANCEL.clear();bridge.PAUSE.clear()
            bridge.execute(session,['G21','G90','G0 X10'],'G54',frame)
            self.assertEqual(bridge.STATE['state'],'error')
            self.assertNotIn(b'G0 X10\n',board.writes)
            self.assertEqual(board.writes[-1],b'!')
            self.assertIsNotNone(session.fault)
        finally:
            session.close()

    def test_fault_while_paused_does_not_leave_worker_locked_forever(self):
        board=FakeGRBL();session=Session(board)
        try:
            frame=session.refresh();session.operation.acquire()
            bridge.CANCEL.clear();bridge.PAUSE.set()
            worker=threading.Thread(target=bridge.execute,args=(session,['G21','G90','G0 X10'],'G54',frame))
            worker.start();session._fail('test unplug')
            worker.join(timeout=1)
            self.assertFalse(worker.is_alive())
            self.assertFalse(session.operation.locked())
            self.assertEqual(bridge.STATE['state'],'error')
        finally:
            bridge.PAUSE.clear();session.close()

    def test_machine_bounds_use_work_offset_and_negative_machine_frame(self):
        coordinates=dict(ready=True,mpos=[-100,-150,-5],wpos=[0,0,5],wco=[-100,-150,-10])
        bridge.validate_machine_path(['G0 X40 Y40','G1 Z0'],coordinates,MACHINE)
        with self.assertRaisesRegex(ValueError,'机器 X'):
            bridge.validate_machine_path(['G1 X150'],coordinates,MACHINE)
        with self.assertRaises((KeyError,ValueError)):
            bridge.validate_machine_path(['G1 X10'],coordinates,{})

    def test_starting_position_must_be_inside_machine_envelope(self):
        coordinates=dict(ready=True,mpos=[-400,-150,-5],wpos=[-300,0,5],wco=[-100,-150,-10])
        with self.assertRaisesRegex(ValueError,'机器 X'):
            bridge.validate_machine_path(['G1 X10'],coordinates,MACHINE)


class PaperOriginLimits(unittest.TestCase):
    def test_negative_paper_range_for_top_left_pen_zero(self):
        limits=dict(xmin=-10,xmax=200,ymin=-289,ymax=8,zmin=0,zmax=10)
        self.assertEqual(len(bridge.validate_job(['G21','G90','G0 X-5 Y-280','G1 X100 Y5 F500'],limits)),4)
        with self.assertRaisesRegex(ValueError,'超出'):
            bridge.validate_job(['G21','G90','G0 X0 Y-290'],limits)
        with self.assertRaisesRegex(ValueError,'范围无效'):
            bridge.validate_job(['G21','G90'],dict(limits,xmin=300))


class BridgeHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=bridge.ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start();cls.url=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def request(self,path,body=None):
        request=urllib.request.Request(self.url+path,data=None if body is None else json.dumps(body).encode(),headers={'X-Bridge-Key':bridge.TOKEN,'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=10) as response:
            return json.load(response)

    @contextlib.contextmanager
    def emulator(self):
        board=FakeGRBL();session=Session(board);session.refresh()
        bridge.SESSION=session;bridge.WORKER=None
        bridge.update(connected=True,state='idle',port='test-only',message='test')
        try:
            yield board,session
        finally:
            bridge.CANCEL.set();bridge.PAUSE.clear()
            if bridge.WORKER and bridge.WORKER.is_alive():bridge.WORKER.join(timeout=2)
            session.close();bridge.SESSION=None;bridge.WORKER=None
            bridge.update(connected=False,state='disconnected')

    def test_authentication_required(self):
        with self.assertRaises(urllib.error.HTTPError) as result:urllib.request.urlopen(self.url+'/api/status')
        self.assertEqual(result.exception.code,401)

    def test_authenticated_status(self):
        request=urllib.request.Request(self.url+'/api/status',headers={'X-Bridge-Key':bridge.TOKEN})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status,200);self.assertEqual(response.headers['Cache-Control'],'no-store')

    def test_cross_origin_rejected(self):
        request=urllib.request.Request(self.url+'/api/status',headers={'X-Bridge-Key':bridge.TOKEN,'Origin':'http://other.invalid'})
        with self.assertRaises(urllib.error.HTTPError) as result:urllib.request.urlopen(request)
        self.assertEqual(result.exception.code,403)

    def test_project_files_not_exposed(self):
        for path in ['/server.py','/grbl.py','/.venv/','/README.md','/requirements.txt']:
            with self.assertRaises(urllib.error.HTTPError) as result:urllib.request.urlopen(self.url+path)
            self.assertEqual(result.exception.code,404)

    def test_web_assets_served_and_head_whitelisted(self):
        for path in ['/','/index.html','/js/common.js','/js/program.js','/css/base.css','/favicon.svg','/demo.gcode','/glyphs/index.json','/glyphs/demo-variants.json']:
            with urllib.request.urlopen(self.url+path) as response:
                self.assertEqual(response.status,200,path)
        for path in ['/server.py','/../server.py','/js/../../grbl.py']:
            request=urllib.request.Request(self.url+path,method='HEAD')
            with self.assertRaises(urllib.error.HTTPError) as result:urllib.request.urlopen(request)
            self.assertEqual(result.exception.code,404)

    def test_index_references_existing_assets(self):
        html=(bridge.ROOT/'index.html').read_text(encoding='utf-8')
        import re
        for ref in re.findall(r'(?:src|href)="\./([^"#]+)"',html):
            self.assertIn('/'+ref,bridge.ASSETS,ref)

    def test_coordinate_read_and_set_are_authoritative(self):
        with self.emulator() as (board,session):
            state=self.request('/api/coordinates/refresh',{})
            self.assertEqual(state['coordinates']['mpos'],[-100,-150,-5])
            expected=state['coordinates']['token']
            result=self.request('/api/coordinates/wcs',dict(expected=expected,wcs='G55',reviewed=True))
            self.assertEqual(result['coordinates']['wcs'],'G55')
            result=self.request('/api/coordinates/zero',dict(expected=result['coordinates']['token'],axes='XY',reviewed=True))
            self.assertEqual(result['coordinates']['wpos'][:2],[0,0])
            self.assertEqual(board.mpos,[-100,-150,-5])

    def test_unknown_or_unsafe_coordinate_action_never_writes(self):
        with self.emulator() as (board,session):
            for path,body in [('/api/coordinates/zero',dict(axes='Z',reviewed=True)),('/api/coordinates/wcs',dict(wcs='G53',reviewed=True)),('/api/coordinates/zero',dict(axes='X',reviewed=False))]:
                body['expected']=session.snapshot()['token']
                with self.assertRaises(urllib.error.HTTPError) as error:self.request(path,body)
                self.assertEqual(error.exception.code,400)
            self.assertFalse(any(line.startswith(b'G10') for line in board.writes))
            self.assertNotIn(b'$H\n',board.writes)

    def start_draining_job(self,board,session):
        write=board.write
        def moving(payload):
            result=write(payload)
            if payload.startswith(b'G0 X20'):
                board.machine_state='Run'
            return result
        board.write=moving
        self.request('/api/job',dict(lines=['G21','G90','G0 Z5','G0 X20 Y20'],limits=LIMITS,machine=MACHINE,expected=session.snapshot()['token'],reviewed=True))
        deadline=time.monotonic()+2
        while bridge.STATE['ack']!=4 and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(bridge.STATE['ack'],4)
        self.assertTrue(bridge.WORKER.is_alive())

    def test_pause_resume_drain_and_terminal_state_cannot_be_overwritten(self):
        with self.emulator() as (board,session):
            self.start_draining_job(board,session)
            state=self.request('/api/pause',{})
            self.assertEqual(state['state'],'paused')
            self.request('/api/resume',{})
            bridge.WORKER.join(timeout=2)
            self.assertEqual(bridge.STATE['state'],'complete')
            with self.assertRaises(urllib.error.HTTPError):self.request('/api/pause',{})
            self.assertEqual(bridge.STATE['state'],'complete')

    def test_jog_and_cancel_endpoints(self):
        with self.emulator() as (board,session):
            session.status()
            self.request('/api/jog',{'axis':'Y','distance':-2,'feed':600,'limits':{'ymin':-300,'ymax':0,'bogus':1}})
            self.assertIn(b'$J=G91 G21 Y-2.000 F600\n',board.writes)
            with self.assertRaises(urllib.error.HTTPError):
                self.request('/api/jog',{'axis':'Y','distance':-500,'feed':600,'limits':{'ymin':-300,'ymax':0}})
            self.request('/api/jog/cancel',{})
            self.assertEqual(board.writes[-1:],[b'\x85'])

    def test_unlock_endpoint_requires_review_and_unlocks_an_alarm(self):
        with self.emulator() as (board,session):
            board.alarm(3)
            deadline=time.monotonic()+2
            while not session.fault and time.monotonic()<deadline: time.sleep(.01)
            state=self.request('/api/status')
            self.assertTrue(state['coordinates']['alarm'])
            with self.assertRaises(urllib.error.HTTPError):
                self.request('/api/unlock',{})
            self.assertNotIn(b'$X\n',board.writes)
            state=self.request('/api/unlock',{'reviewed':True})
            self.assertEqual(state['coordinates']['machineState'],'Idle')
            self.assertFalse(state['coordinates']['alarm'])
            self.assertTrue(state['connected'])

    def test_soft_reset_invalidates_coordinates_and_requires_reconnect(self):
        with self.emulator() as (board,session):
            self.start_draining_job(board,session)
            state=self.request('/api/stop',{})
            bridge.WORKER.join(timeout=2)
            self.assertEqual(bridge.STATE['state'],'stopped')
            self.assertFalse(state['coordinates']['ready'])
            self.assertIsNone(state['coordinates']['mpos'])
            self.assertIn(b'\x18',board.writes)
            self.assertIsNotNone(session.fault)

    def test_job_requires_current_token_and_both_coordinate_envelopes(self):
        with self.emulator() as (board,session):
            base=dict(lines=['G21','G90','G0 Z5','G0 X20 Y20'],limits=LIMITS,machine=MACHINE,reviewed=True)
            with self.assertRaises(urllib.error.HTTPError):self.request('/api/job',{**base,'expected':'old-token'})
            with self.assertRaises(urllib.error.HTTPError):self.request('/api/job',{**base,'expected':session.snapshot()['token'],'lines':['G21','G90','G1 X150 F500']})
            self.assertFalse(any(line.startswith(b'G1 ') for line in board.writes))
            result=self.request('/api/job',{**base,'expected':session.snapshot()['token']})
            bridge.WORKER.join(timeout=2)
            self.assertEqual(bridge.STATE['state'],'complete')
            self.assertEqual(bridge.STATE['ack'],4)
            self.assertEqual(result['wcs'],'G54')
            self.assertIn(b'G54\n',board.writes)
