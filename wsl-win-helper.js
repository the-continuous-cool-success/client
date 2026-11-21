"use strict";

/**
 * Runs under Windows Node from WSL. No native addons — uses PowerShell + user32.
 * Lines: ping | clip | caps | char <vKey> <scanCode> <shift> <caps>
 */
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const PS_UNICODE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinCUser32 {
  [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte[] lpKeyState);
  [DllImport("user32.dll")] public static extern short GetKeyState(int nVirtKey);
  [DllImport("user32.dll")] public static extern int ToUnicodeEx(uint wVirtKey, uint wScanCode, byte[] lpKeyState, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszBuff, int cchBuff, uint wFlags, IntPtr dwhkl);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  public static string Char(uint vk, uint sc, bool shift, bool caps) {
    byte[] st = new byte[256];
    if (!GetKeyboardState(st)) return "";
    if (shift) { st[0x10] = (byte)(st[0x10] | 0x80); st[0xA0] = (byte)(st[0xA0] | 0x80); }
    if (caps) st[0x14] = (byte)(st[0x14] | 0x01);
    if (vk < st.Length) st[vk] = (byte)(st[vk] | 0x80);
    var sb = new StringBuilder(8);
    int n = ToUnicodeEx(vk, sc, st, sb, 4, 0, GetKeyboardLayout(0));
    return n == 1 ? sb.ToString() : "";
  }
  public static bool CapsOn() { return (GetKeyState(0x14) & 1) != 0; }
}
'@ -ErrorAction Stop
`;


function powershellExe() {
  const windir = process.env.windir || process.env.WINDIR || "C:\\Windows";
  return `${windir}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function runPowerShell(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExe(),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) {
        reject(new Error(err.trim() || `PowerShell exit ${code}`));
        return;
      }
      resolve(out);
    });
  });
}

async function toUnicodeChar(vKey, scanCode, shift, caps) {
  const cmd = `[WinCUser32]::Char(${vKey}u,${scanCode}u,${shift ? "$true" : "$false"},${caps ? "$true" : "$false"})`;
  const out = await runPowerShell(`${PS_UNICODE}; ${cmd}`);
  return out.replace(/\r?\n$/, "");
}

async function readClipboardText() {
  const cmd = `
    $t = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    if (-not $t) {
      try {
        Add-Type -AssemblyName System.Windows.Forms
        $t = [System.Windows.Forms.Clipboard]::GetText()
      } catch { $t = '' }
    }
    if ($null -eq $t) { $t = '' }
    Write-Output ('CLIPB64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))
  `;
  const out = await runPowerShell(cmd);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("CLIPB64:"));
  if (!line) {
    return "";
  }
  return Buffer.from(line.slice(8), "base64").toString("utf8");
}

async function readCapsLock() {
  const out = await runPowerShell(`${PS_UNICODE}; if ([WinCUser32]::CapsOn()) { '1' } else { '0' }`);
  return out.trim() === "1";
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", (line) => {
  void (async () => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      if (trimmed === "ping") {
        process.stdout.write("pong\n");
        return;
      }
      if (trimmed === "clip") {
        const text = await readClipboardText();
        process.stdout.write(`CLIPB64:${Buffer.from(text || "", "utf8").toString("base64")}\n`);
        return;
      }
      if (trimmed === "caps") {
        const on = await readCapsLock();
        process.stdout.write(on ? "1\n" : "0\n");
        return;
      }
      if (trimmed.startsWith("char ")) {
        const parts = trimmed.split(/\s+/);
        const vk = Number(parts[1]);
        const sc = Number(parts[2]);
        const shift = Number(parts[3]) === 1;
        const caps = Number(parts[4]) === 1;
        if (!Number.isFinite(vk) || !Number.isFinite(sc)) {
          process.stdout.write("\n");
          return;
        }
        const ch = await toUnicodeChar(vk, sc, shift, caps);
        process.stdout.write(`${ch}\n`);
        return;
      }
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.stdout.write("\n");
    }
  })();
});