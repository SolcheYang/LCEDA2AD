#!/usr/bin/env python
"""Check that a PcbLib component actually contains persisted primitives.

olefile reads the OLE compound file directly. An empty placeholder component has
a ~38-byte Data stream; a component with pads/tracks/arcs has hundreds of bytes
or more. Exit 0 only when the wanted component (or, as a fallback, any component)
has a non-trivial Data stream.
"""
import json
import os
import sys

try:
    import olefile
except ImportError:
    # 仓库自带一份（tools/vendor/olefile，BSD-2-Clause 许可），git clone 后
    # 无需 pip install；只有这份副本也缺失时才跳过校验。
    vendor = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
    if os.path.isdir(vendor):
        sys.path.insert(0, vendor)
    try:
        import olefile
    except ImportError:
        # 退出码 3 = "校验工具不可用"，与 1（元件确实没有图元）严格区分，
        # 调用方据此跳过校验，不能把它当成断言失败。
        print(json.dumps({"ok": None, "reason": "olefile not installed (vendored copy missing too)"}))
        sys.exit(3)

if len(sys.argv) < 2:
    print(json.dumps({"ok": False, "reason": "usage: pcblib-check.py <lib> [component-name]"}))
    sys.exit(2)

lib = sys.argv[1]
want = sys.argv[2] if len(sys.argv) > 2 else ""
try:
    ole = olefile.OleFileIO(lib)
except Exception as exc:
    print(json.dumps({"ok": False, "reason": "cannot open OLE: %s" % exc}))
    sys.exit(1)

known = {"FileVersionInfo", "Library", "SectionKeys"}
components = []
for entry in ole.listdir(streams=False, storages=True):
    if len(entry) != 1:
        continue
    name = entry[0]
    if name in known:
        continue
    data_path = name + "/Data"
    if ole.exists(data_path) and ole.get_type(data_path) == 2:
        components.append({"name": name, "data": ole.get_size(data_path)})
ole.close()

want_l = want.lower()
matching = [c for c in components if want_l and (want_l.startswith(c["name"].lower()) or c["name"].lower() == want_l)]
populated = [c for c in (matching or components) if c["data"] > 100]
result = {
    "ok": bool(populated),
    "want": want,
    "components": components,
    "populated": populated,
}
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if populated else 1)
