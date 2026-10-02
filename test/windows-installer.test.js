import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const installer = readFileSync(new URL('../public/install-print-agent.ps1', import.meta.url), 'utf8');

test('Windows installer can update an existing agent from the demo branch without changing the default', () => {
  assert.match(installer, /\[ValidateSet\("main", "demo"\)\]/);
  assert.match(installer, /\[string\]\$SourceBranch = "main"/);
  assert.match(installer, /zip\/refs\/heads\/\$SourceBranch/);
  assert.doesNotMatch(installer, /New-Printer|Remove-Printer|Set-Printer/);
});

test('Windows launchers resolve Unicode user paths at runtime', () => {
  const startScript = installer.match(/function Write-StartScript \{[\s\S]*?\$content = @"\r?\n([\s\S]*?)\r?\n"@/);
  const startupLauncher = installer.match(/function Register-StartupLauncher \{[\s\S]*?\$content = @"\r?\n([\s\S]*?)\r?\n"@/);
  assert.ok(startScript, 'start-agent.cmd template exists');
  assert.ok(startupLauncher, 'startup VBS template exists');

  const batch = startScript[1].replace('$Port', '37951');
  const vbs = startupLauncher[1];
  assert.match(batch, /set "PRINTWARD_AGENT_ROOT=%LOCALAPPDATA%\\PrintwardAgent"/);
  assert.match(batch, /set "PRINTWARD_AGENT_LOG=%PRINTWARD_AGENT_ROOT%\\agent\.log"/);
  assert.match(batch, /"%PRINTWARD_AGENT_NODE%" "%PRINTWARD_AGENT_APP%\\src\\local-agent\.js"/);
  assert.match(vbs, /shell\.ExpandEnvironmentStrings\("%LOCALAPPDATA%"\)/);
  assert.match(vbs, /shell\.Run Chr\(34\) & startCmd & Chr\(34\)/);
  assert.doesNotMatch(batch + vbs, /\$InstallRoot|\$AppDir|\$NodeExe|\$SumatraExe|\$LogPath|\$StartCmd/);
  assert.match(installer, /Set-Content -Path \$startCmd -Value \$content -Encoding ASCII/);
  assert.match(installer, /Set-Content -Path \$launcher -Value \$content -Encoding ASCII/);
  assert.match(installer, /\$startCmd = Write-StartScript\s+Register-StartupLauncher\s+Start-And-Verify \$startCmd/);
});
