# 随仓库附带的第三方库

## olefile 0.47

- 来源：<https://pypi.org/project/olefile/>（`olefile-0.47-py2.py3-none-any.whl`）
- 许可：BSD-2-Clause，见 `olefile/LICENSE.txt`
- 用途：`tools/pcblib-check.py` 直接读取 `.PcbLib` 的 OLE 复合文档，
  确认封装里确实写入了焊盘/走线等图元。

放在这里是为了让 `git clone` 下来的人**不需要** `pip install olefile`，
也不需要联网或管理员权限。`pcblib-check.py` 会先尝试系统里已安装的
olefile，导入失败时再回退到本目录。

升级方法：

```cmd
python -m pip download olefile --no-deps -d %TEMP%\olefile-dl
:: 解压 wheel，把 olefile\__init__.py / olefile.py / olefile2.py / LICENSE.txt /
:: CONTRIBUTORS.txt 覆盖到本目录
```
