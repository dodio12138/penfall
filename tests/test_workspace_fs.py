import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from workspace_fs import FsError, WorkspaceRoot  # noqa: E402

spec = importlib.util.spec_from_file_location('bridge_fs', ROOT / 'server.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class WorkspaceRootTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.files = WorkspaceRoot(self.tmp.name)
        self.files.create('信件', '{}')

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_list_read_write_rename_delete(self):
        self.files.mkdir('信件', '家人')
        stamp = self.files.write('信件', '家人/给妈妈.txt', '你好', None)['mtime']
        self.assertEqual(self.files.read('信件', '家人/给妈妈.txt'), {'content': '你好', 'mtime': stamp})
        self.files.rename('信件', '家人/给妈妈.txt', '家人/给母亲.txt')
        self.files.rename('信件', '家人', '亲人')
        paths = [entry['path'] for entry in self.files.list('信件')]
        self.assertEqual(paths, ['亲人', 'workspace.wtw', '亲人/给母亲.txt'])
        self.files.delete('信件', '亲人')
        self.assertEqual([entry['path'] for entry in self.files.list('信件')], ['workspace.wtw'])

    def test_conflicting_writes_are_rejected(self):
        first = self.files.write('信件', 'a.txt', 'one', None)['mtime']
        with self.assertRaises(FsError) as error:
            self.files.write('信件', 'a.txt', 'again', None)
        self.assertEqual(error.exception.status, 409)
        self.files.write('信件', 'a.txt', 'two', first)
        with self.assertRaises(FsError) as error:
            self.files.write('信件', 'a.txt', 'stale', first)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.files.read('信件', 'a.txt')['content'], 'two')

    def test_paths_cannot_escape_or_touch_other_types(self):
        outside = pathlib.Path(self.tmp.name) / 'secret.txt'
        outside.write_text('x')
        for path in ['../secret.txt', '/etc/passwd', 'a/../../secret.txt', '.hidden.txt', 'a\\b.txt', 'x.py', 'x.json', '']:
            with self.assertRaises(FsError, msg=path):
                self.files.write('信件', path, 'boom')
        for name in ['..', '.', '', 'a/b']:
            with self.assertRaises(FsError):
                self.files.list(name)
        link = pathlib.Path(self.tmp.name) / '信件' / 'link.txt'
        link.symlink_to(outside)
        with self.assertRaises(FsError):
            self.files.read('信件', 'link.txt')
        self.assertNotIn('link.txt', [entry['path'] for entry in self.files.list('信件')])


class FileApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        bridge.FILES = WorkspaceRoot(cls.tmp.name)
        cls.server = bridge.ThreadingHTTPServer(('127.0.0.1', 0), bridge.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.tmp.cleanup()

    def call(self, path, body=None, key=None):
        request = urllib.request.Request(self.url + path, data=None if body is None else json.dumps(body).encode(), headers={'X-Bridge-Key': key or bridge.TOKEN, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def test_round_trip_and_errors(self):
        self.call('/api/fs/workspaces', {'name': '测试'})
        self.assertIn('测试', self.call('/api/fs/workspaces')['workspaces'])
        stamp = self.call('/api/fs/write', {'ws': '测试', 'path': '稿.txt', 'content': 'HELLO', 'base': None})['mtime']
        self.assertEqual(self.call('/api/fs/read?ws=%E6%B5%8B%E8%AF%95&path=%E7%A8%BF.txt')['content'], 'HELLO')
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/fs/write', {'ws': '测试', 'path': '稿.txt', 'content': 'X', 'base': stamp - 1})
        self.assertEqual(error.exception.code, 409)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/fs/write', {'ws': '测试', 'path': '../x.txt', 'content': 'X'})
        self.assertEqual(error.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/fs/workspaces', key='wrong-key')
        self.assertEqual(error.exception.code, 401)


class KeyFileTests(unittest.TestCase):
    def test_key_is_stable_until_renewed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'key'
            first = bridge.load_key(path)
            self.assertEqual(bridge.load_key(path), first)
            self.assertNotEqual(bridge.load_key(path, renew=True), first)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
