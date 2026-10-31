@echo off
setlocal
if "%ALTIUM_EXE%"=="" set "ALTIUM_EXE=E:\AD\AD\X2.EXE"
start "" "%ALTIUM_EXE%" -RScriptingSystem:RunScript(ProjectName="E:\EDA2Altium-exe\jobs\C14709-schlib\job.PrjScr"^|ProcName="RunJob")
endlocal
