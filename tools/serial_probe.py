#!/usr/bin/env python3
"""Identify the firmware of a writing machine controller over USB serial — read-only.

Sends only queries that do not move, reset or reconfigure anything:
  (nothing)   listen for a startup banner
  $I          GRBL build info        -> [VER:1.1h...]
  ?           GRBL realtime status   -> <Idle|MPos:...>
  M115        Marlin firmware info   -> FIRMWARE_NAME:Marlin ...
  V           EiBotBoard / AxiDraw   -> EBBv13_and_above ...
Unknown firmwares normally answer these with an error message, which is harmless.

Usage:
  .venv/bin/python tools/serial_probe.py                 # list ports
  .venv/bin/python tools/serial_probe.py PORT [BAUD ...]  # probe (default bauds: 115200 250000 57600 9600)
"""
import re
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit('请先安装 pyserial：.venv/bin/python -m pip install -r requirements.txt')

QUERIES = [b'\r\n', b'$I\n', b'?', b'\r\n', b'M115\n', b'V\r']


def ports():
    found = list(list_ports.comports())
    if not found:
        print('没有发现串口。请检查 USB 线（有些线只能充电）和驱动（CH340 / CP210x）。')
    for port in found:
        ids = f'{port.vid:04x}:{port.pid:04x}' if port.vid is not None else '—'
        print(f'{port.device:32} {port.description} | 厂商 {port.manufacturer or "—"} | VID:PID {ids}')
    return found


def listen(board, seconds):
    deadline, data = time.monotonic() + seconds, b''
    while time.monotonic() < deadline:
        chunk = board.read(256)
        if chunk:
            data += chunk
            deadline = max(deadline, time.monotonic() + .3)  # keep reading while text keeps coming
    return data


def show(data):
    text = data.decode('ascii', errors='replace')
    printable = sum(ch.isprintable() or ch in '\r\n\t' for ch in text)
    for line in text.replace('\r', '\n').split('\n'):
        if line.strip():
            print('   ', repr(line.strip())[:160])
    return text, (printable / len(text) if text else 1)


def verdict(text):
    if re.search(r'^Grbl 1\.1', text, re.M) or '[VER:1.1' in text:
        return 'GRBL 1.1 —— 可以使用本项目。若之前连接被拒，多半是打开串口时控制板没有复位、没打印启动标识（新版连接会主动查询 $I）。'
    if re.search(r'GrblHAL|grblHAL', text):
        return 'grblHAL —— 与 GRBL 1.1 协议兼容，新版连接会通过 $I 识别。'
    if re.search(r'^Grbl 0\.|\[VER:0\.', text, re.M):
        return 'GRBL 0.9 或更早 —— 协议与 1.1 不同（状态报告格式不一样），需要先升级到 GRBL 1.1。'
    if re.search(r'^Grbl ', text, re.M):
        return '自称 Grbl，但不是 1.1 —— 请把上面的原始回应发给我。'
    if 'FIRMWARE_NAME' in text or 'Marlin' in text:
        return 'Marlin（3D 打印机类固件）—— 不是 GRBL，暂不支持；需要单独的设备适配。'
    if re.search(r'EBB|EiBotBoard|DrawCore', text):
        return 'EiBotBoard / AxiDraw 协议 —— 完全不同的指令集（SM / SP），暂不支持；需要单独的设备适配。'
    if text.strip():
        return '未识别的固件 —— 请把上面的原始回应发给我。'
    return '没有任何回应 —— 可能波特率不对、选错了串口，或控制器需要专用上位机协议。'


def probe(device, bauds):
    for baud in bauds:
        print(f'\n== {device} @ {baud}')
        try:
            board = serial.Serial(device, baud, timeout=.1, write_timeout=2, exclusive=True)
        except Exception as error:
            print('   无法打开：', error)
            return
        try:
            print(' 1) 打开后等待启动标识（4 秒）：')
            text, quality = show(listen(board, 4))
            for query in QUERIES:
                board.write(query)
                time.sleep(.05)
            print(' 2) 发送只读查询 $I、?、M115、V 后的回应：')
            more, more_quality = show(listen(board, 2))
            text += more
            if text.strip() and min(quality, more_quality) < .8:
                print('   （大量乱码：波特率很可能不对）')
                continue
            print(' 判断：', verdict(text))
            if text.strip():
                return
        finally:
            board.close()
    print('\n所有波特率都没有可读的回应。')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        ports()
        print('\n用法：.venv/bin/python tools/serial_probe.py 串口 [波特率 ...]')
    else:
        probe(sys.argv[1], [int(value) for value in sys.argv[2:]] or [115200, 250000, 57600, 9600])
