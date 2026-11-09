import time
import unittest
from grbl import Coordinates, Session, ProtocolError
from fake_grbl import FakeGRBL


def populate(model, inches=0):
    model.feed(f'$13={inches}')
    model.feed('[GC:G0 G54 G17 G21 G90 G94 M5]')
    model.feed('[G54:-100,-150,-10]')
    model.feed('[G92:0,0,0]')
    model.feed('[TLO:0]')
    model.feed('<Idle|MPos:-100,-150,-5|WCO:-100,-150,-10>')


class CoordinateReports(unittest.TestCase):
    def test_unknown_is_not_zero(self):
        data=Coordinates().snapshot()
        self.assertIsNone(data['mpos'])
        self.assertIsNone(data['wpos'])
        self.assertIsNone(data['wcs'])
        self.assertFalse(data['ready'])

    def test_negative_machine_position_and_work_conversion(self):
        model=Coordinates()
        populate(model)
        data=model.snapshot()
        self.assertTrue(data['ready'])
        self.assertEqual(data['mpos'],[-100,-150,-5])
        self.assertEqual(data['wpos'],[0,0,5])
        model.feed('<Idle|WPos:1,2,3>')
        self.assertEqual(model.snapshot()['mpos'],[-99,-148,-7])

    def test_unknown_offset_not_assumed_zero(self):
        model=Coordinates()
        model.feed('$13=0')
        model.feed('<Idle|MPos:10,20,30>')
        self.assertEqual(model.snapshot()['mpos'],[10,20,30])
        self.assertIsNone(model.snapshot()['wpos'])
        self.assertFalse(model.snapshot()['ready'])

    def test_inch_reports_independent_of_G21(self):
        model=Coordinates()
        model.feed('$13=1')
        model.feed('[GC:G0 G54 G21 G90 G94]')
        model.feed('[G54:1,2,3]')
        model.feed('[G92:0,0,0]')
        model.feed('[TLO:0]')
        model.feed('<Idle|MPos:2,3,4|WCO:1,2,3>')
        data=model.snapshot()
        self.assertTrue(data['ready'])
        self.assertEqual(data['units'],'mm')
        self.assertEqual(data['wpos'],[25.4,25.4,25.4])
        self.assertEqual(data['mpos'],[50.8,76.2,101.6])

    def test_offsets_must_agree_with_reported_WCO(self):
        model=Coordinates();populate(model)
        model.feed('[G54:-90,-150,-10]')
        self.assertFalse(model.snapshot()['ready'])
        model.feed('<Idle|MPos:-100,-150,-5|WCO:-90,-150,-10>')
        self.assertTrue(model.snapshot()['ready'])

    def test_g92_and_tool_length_in_WCO(self):
        model=Coordinates();populate(model)
        model.feed('[G92:1,2,3]');model.feed('[TLO:4]')
        model.feed('<Idle|MPos:-100,-150,-5|WCO:-99,-148,-3>')
        self.assertTrue(model.snapshot()['ready'])
        self.assertEqual(model.snapshot()['wpos'],[-1,-2,-2])

    def test_stale_report_and_reset_clear_usable_position(self):
        now=[0.0]
        model=Coordinates(clock=lambda:now[0]);populate(model)
        self.assertTrue(model.snapshot()['ready'])
        now[0]=3
        self.assertIsNone(model.snapshot()['mpos'])
        self.assertIsNone(model.snapshot()['token'])
        model.feed("Grbl 1.1h ['$' for help]")
        self.assertIsNone(model.snapshot()['wco'])
        self.assertIsNone(model.snapshot()['wcs'])
        self.assertFalse(model.snapshot()['ready'])

    def test_token_binds_position_and_frame(self):
        model=Coordinates();populate(model)
        first=model.snapshot()
        model.feed('<Idle|MPos:-99,-150,-5>')
        second=model.snapshot()
        self.assertNotEqual(first['token'],second['token'])
        self.assertEqual(first['frameToken'],second['frameToken'])

    def test_bad_or_extra_axes_not_silently_accepted(self):
        for line in ['<Idle|MPos:NaN,0,0>','<Idle|MPos:1,2,3,4>','<Idle,MPos:0,0,0>']:
            with self.subTest(line=line),self.assertRaises(ProtocolError):
                Coordinates().feed(line)


class SerialTransactions(unittest.TestCase):
    def setUp(self):
        self.board=FakeGRBL()
        self.session=Session(self.board)
        self.session.refresh()

    def tearDown(self):
        self.session.close()

    def test_single_reader_handles_poll_and_command_acks(self):
        self.session.start_polling()
        for _ in range(5):
            self.session.command('$G')
        self.assertEqual(len(self.board.reader_threads),1)
        self.assertTrue(self.session.snapshot()['ready'])

    def test_switch_requires_token_and_readback(self):
        token=self.session.snapshot()['token']
        result=self.session.coordinate_action('wcs',token,target='G55')
        self.assertEqual(result['wcs'],'G55')
        self.assertEqual(self.board.mpos,[-100,-150,-5])
        self.assertIn(b'G55\n',self.board.writes)
        self.assertIn(b'$#\n',self.board.writes)

    def test_zero_XY_preserves_machine_position_and_Z_offset(self):
        self.session.coordinate_action('wcs',self.session.snapshot()['token'],target='G55')
        z=self.board.offsets['G55'][2]
        data=self.session.coordinate_action('zero',self.session.snapshot()['token'],axes='XY')
        self.assertEqual(data['wpos'][:2],[0,0])
        self.assertEqual(self.board.mpos,[-100,-150,-5])
        self.assertEqual(self.board.offsets['G55'][2],z)
        self.assertIn(b'G10 L20 P2 X0 Y0\n',self.board.writes)

    def test_stale_token_and_bad_axes_never_write(self):
        for expected,axes in [('bad','XY'),(self.session.snapshot()['token'],'XYZ')]:
            with self.assertRaises(ProtocolError):
                self.session.coordinate_action('zero',expected,axes=axes)
        self.assertFalse(any(line.startswith(b'G10') for line in self.board.writes))

    def test_not_idle_never_sets_zero(self):
        self.board.machine_state='Run'
        with self.assertRaises(ProtocolError):
            self.session.coordinate_action('zero',self.session.snapshot()['token'],axes='XY')
        self.assertFalse(any(line.startswith(b'G10') for line in self.board.writes))

    def test_operation_lock_rejects_concurrent_job_or_coordinates(self):
        with self.session.reserve('job'):
            with self.assertRaises(ProtocolError):
                self.session.coordinate_action('wcs',self.session.snapshot()['token'],target='G55')
        self.assertNotIn(b'G55\n',self.board.writes)

    def test_timeout_quarantines_late_ok(self):
        self.board.drop_code='G55'
        with self.assertRaises(ProtocolError):
            self.session.command('G55',timeout=.03)
        self.board.emit('ok')
        with self.assertRaises(ProtocolError):
            self.session.command('G56')
        self.assertNotIn(b'G56\n',self.board.writes)
        self.assertFalse(self.session.snapshot()['ready'])

    def test_fragmented_serial_reports_are_reassembled(self):
        self.board.responses.put(b'<Idle|MPos:-99,')
        self.board.responses.put(b'-149,-5|WCO:-100,-150,-10>\r\n')
        deadline=time.monotonic()+1
        while time.monotonic()<deadline and self.session.snapshot()['wpos'] != [1,1,5]:
            time.sleep(.01)
        self.assertEqual(self.session.snapshot()['wpos'],[1,1,5])

    def test_failed_write_does_not_claim_coordinate_success(self):
        self.board.fail_code='G55'
        with self.assertRaises(ProtocolError):
            self.session.coordinate_action('wcs',self.session.snapshot()['token'],target='G55')
        self.assertEqual(self.board.wcs,'G54')
        self.assertFalse(self.session.snapshot()['ready'])
