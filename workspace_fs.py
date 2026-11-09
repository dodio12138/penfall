"""Disk-backed workspaces for the web UI: one folder per workspace under a fixed root.

Only plain text project files are exposed (.txt .md .gcode .nc .tap .wtl .wtw); every path is
validated and resolved inside its workspace, so the API cannot reach other files on the machine.
"""
import os
import re
import shutil
import threading
from pathlib import Path

FILE_TYPES = {'.txt', '.md', '.gcode', '.nc', '.tap', '.wtl', '.wtw', '.svg', '.dxf'}
MAX_CONTENT = 1_500_000
MAX_DEPTH = 8
MAX_ENTRIES = 5000
MANIFEST = 'workspace.wtw'
_PART = re.compile(r'^[^\x00-\x1f\\/:*?"<>|]{1,120}$')
LOCK = threading.RLock()


class FsError(ValueError):
    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


def _check_part(part):
    if not _PART.match(part) or part.startswith('.') or part.strip() != part or part.endswith('.'):
        raise FsError(f'名称无效：{part!r}')
    return part


def mtime(path):
    return path.stat().st_mtime_ns // 1000


class WorkspaceRoot:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()

    def ensure(self):
        self.root.mkdir(parents=True, exist_ok=True)

    def workspaces(self):
        self.ensure()
        return sorted(item.name for item in self.root.iterdir() if item.is_dir() and not item.name.startswith('.'))

    def create(self, name, manifest):
        folder = self.root / _check_part(str(name))
        with LOCK:
            self.ensure()
            if folder.exists():
                raise FsError('同名工作区已存在', 409)
            folder.mkdir()
            (folder / MANIFEST).write_text(manifest, encoding='utf-8')
        return name

    def workspace(self, name):
        folder = self.root / _check_part(str(name or ''))
        if not folder.is_dir():
            raise FsError('工作区不存在', 404)
        return folder.resolve()

    def resolve(self, name, path, kind='file'):
        """Relative POSIX path → absolute path inside the workspace (no traversal, no symlink escape)."""
        base = self.workspace(name)
        if not isinstance(path, str) or not path or path.startswith('/') or '\\' in path:
            raise FsError('路径无效')
        parts = path.split('/')
        if len(parts) > MAX_DEPTH:
            raise FsError('目录层级过深')
        for part in parts:
            _check_part(part)
        if kind == 'file' and Path(parts[-1]).suffix.lower() not in FILE_TYPES:
            raise FsError('只支持 .txt .md .gcode .nc .tap .svg .dxf .wtl .wtw 文件')
        target = base.joinpath(*parts)
        resolved = target.resolve()
        if resolved != base and base not in resolved.parents:
            raise FsError('路径超出工作区')
        return target

    def list(self, name):
        base = self.workspace(name)
        entries = []
        for directory, folders, files in os.walk(base):
            current = Path(directory)
            depth = len(current.relative_to(base).parts)
            folders[:] = sorted(f for f in folders if not f.startswith('.') and not (current / f).is_symlink() and depth < MAX_DEPTH)
            for folder in folders:
                entries.append({'path': (current / folder).relative_to(base).as_posix(), 'type': 'dir'})
            for file in sorted(files):
                path = current / file
                if file.startswith('.') or path.is_symlink() or path.suffix.lower() not in FILE_TYPES:
                    continue
                stat = path.stat()
                entries.append({'path': path.relative_to(base).as_posix(), 'type': 'file', 'size': stat.st_size, 'mtime': stat.st_mtime_ns // 1000})
            if len(entries) > MAX_ENTRIES:
                raise FsError('工作区文件过多（上限 5000）')
        return entries

    def read(self, name, path):
        target = self.resolve(name, path)
        if not target.is_file():
            raise FsError('文件不存在', 404)
        if target.stat().st_size > MAX_CONTENT * 4:
            raise FsError('文件过大')
        try:
            content = target.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            raise FsError('文件不是 UTF-8 文本')
        return {'content': content, 'mtime': mtime(target)}

    def write(self, name, path, content, base=...):
        """base: ... = overwrite, None = create only, int = must still have this mtime (else 409)."""
        if not isinstance(content, str) or len(content) > MAX_CONTENT:
            raise FsError('内容无效或超过 150 万字符')
        target = self.resolve(name, path)
        with LOCK:
            exists = target.exists()
            if exists and not target.is_file():
                raise FsError('同名文件夹已存在', 409)
            if base is None and exists:
                raise FsError('文件已存在', 409, mtime=mtime(target))
            if isinstance(base, int) and (not exists or mtime(target) != base):
                raise FsError('文件已在其他地方被修改', 409, mtime=mtime(target) if exists else None)
            if not target.parent.is_dir():
                raise FsError('所在文件夹不存在', 404)
            temporary = target.with_name(f'.{target.name}.{threading.get_ident()}.tmp')
            temporary.write_text(content, encoding='utf-8')
            os.replace(temporary, target)
            return {'mtime': mtime(target)}

    def mkdir(self, name, path):
        target = self.resolve(name, path, kind='dir')
        with LOCK:
            if target.exists():
                raise FsError('同名文件或文件夹已存在', 409)
            if not target.parent.is_dir():
                raise FsError('上级文件夹不存在', 404)
            target.mkdir()

    def rename(self, name, source, destination):
        is_dir = (self.workspace(name) / source).is_dir() if isinstance(source, str) and '..' not in source else False
        kind = 'dir' if is_dir else 'file'
        old, new = self.resolve(name, source, kind), self.resolve(name, destination, kind)
        with LOCK:
            if not old.exists():
                raise FsError('原文件不存在', 404)
            if new.exists() and new.resolve() != old.resolve():
                raise FsError('目标名称已存在', 409)
            if is_dir and (new == old or old in new.parents):
                raise FsError('不能移动到自身内部')
            if not new.parent.is_dir():
                raise FsError('目标文件夹不存在', 404)
            os.replace(old, new)

    def delete(self, name, path):
        base = self.workspace(name)
        is_dir = isinstance(path, str) and (base / path).is_dir() and '..' not in path.split('/')
        target = self.resolve(name, path, 'dir' if is_dir else 'file')
        with LOCK:
            if is_dir:
                shutil.rmtree(target)
            elif target.is_file():
                target.unlink()
            else:
                raise FsError('文件不存在', 404)
