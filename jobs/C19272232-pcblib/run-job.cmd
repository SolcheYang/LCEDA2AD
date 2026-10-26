@echo off
setlocal
if "%ALTIUM_EXE%"=="" set "ALTIUM_EXE=E:\AD\AD\X2.EXE"
start "" "%ALTIUM_EXE%" -RScriptingSystem:RunScript(ProjectName="E:\EDA2Altium-exe\jobs\C19272232-pcblib\job.PrjScr"^|ProcName="RunJob")
endlocal
