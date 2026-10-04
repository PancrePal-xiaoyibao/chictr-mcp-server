/**
 * env-probe 单元测试。
 *
 * 重点覆盖「误报」——环境探测如果给出错误的结论，比不探测更糟：
 *   - 假阴性（环境好的却报缺失）会让用户白折腾
 *   - 假阳性（缺失却报就绪）会让用户以为能跑，直到运行时才炸
 * 这两类都在真实测试中踩到过，因此专门固化为用例。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getEnvReport,
  invalidateEnvReport,
  formatEnvReport,
  projectRoot,
  venvDir,
  venvPython,
  sidecarScript,
  playwrightCacheDir,
  type EnvReport,
} from "./env-probe.js";

let sandbox: string;

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "env-probe-test-"));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("projectRoot", () => {
  it("CHICTR_HOME 优先于自动推断", () => {
    const prev = process.env.CHICTR_HOME;
    process.env.CHICTR_HOME = sandbox;
    try {
      assert.strictEqual(projectRoot(), sandbox);
    } finally {
      if (prev === undefined) delete process.env.CHICTR_HOME;
      else process.env.CHICTR_HOME = prev;
    }
  });

  it("自动推断时能找到含 package.json 与 sidecar 的真实根目录", () => {
    const prev = process.env.CHICTR_HOME;
    delete process.env.CHICTR_HOME;
    try {
      const root = projectRoot();
      // 必须是本项目根，而不是 dist/ 之类的中间目录——否则 venv 会被建到错位置。
      assert.ok(root.endsWith("chictr_trials"), `意外的根目录: ${root}`);
    } finally {
      if (prev !== undefined) process.env.CHICTR_HOME = prev;
    }
  });
});

describe("路径推导", () => {
  it("venvPython 按平台给出正确文件名", () => {
    const py = venvPython();
    if (process.platform === "win32") {
      assert.ok(py.endsWith(path.join("Scripts", "python.exe")), py);
    } else {
      assert.ok(py.endsWith(path.join("bin", "python3")), py);
    }
  });

  it("venvDir 可用 CHICTR_VENV 覆盖", () => {
    const prev = process.env.CHICTR_VENV;
    const custom = path.join(sandbox, "custom-venv");
    process.env.CHICTR_VENV = custom;
    try {
      assert.strictEqual(venvDir(), custom);
    } finally {
      if (prev === undefined) delete process.env.CHICTR_VENV;
      else process.env.CHICTR_VENV = prev;
    }
  });

  it("sidecarScript 指向真实存在的脚本", () => {
    const script = sidecarScript();
    assert.ok(script.endsWith(path.join("sidecar", "chictr_sidecar.py")), script);
  });

  it("playwrightCacheDir 落在平台约定位置", () => {
    const dir = playwrightCacheDir();
    assert.ok(dir.length > 0);
    if (process.platform === "darwin") {
      assert.ok(dir.includes(path.join("Library", "Caches", "ms-playwright")), dir);
    }
  });
});

describe("probeEnvironment 在破损环境下的行为", () => {
  it("缺 venv 时报 missing，且不抛异常", async () => {
    const prevHome = process.env.CHICTR_HOME;
    process.env.CHICTR_HOME = sandbox; // 空目录 = 未安装
    invalidateEnvReport();
    try {
      const report = await getEnvReport(true);
      assert.strictEqual(report.venv.status, "missing");
      assert.strictEqual(report.canRunBrowserless, false);
      assert.ok(report.actions.length > 0, "应给出修复动作");
      assert.ok(report.summary.length > 0);
    } finally {
      if (prevHome === undefined) delete process.env.CHICTR_HOME;
      else process.env.CHICTR_HOME = prevHome;
      invalidateEnvReport();
    }
  });

  it("sidecar 未启用时状态为 unknown 而非 missing（不需要 ≠ 缺失）", async () => {
    const prevHome = process.env.CHICTR_HOME;
    const prevUse = process.env.CHICTR_USE_SIDECAR;
    process.env.CHICTR_HOME = sandbox;
    delete process.env.CHICTR_USE_SIDECAR;
    invalidateEnvReport();
    try {
      const report = await getEnvReport(true);
      assert.strictEqual(report.sidecar.status, "unknown");
    } finally {
      if (prevHome === undefined) delete process.env.CHICTR_HOME;
      else process.env.CHICTR_HOME = prevHome;
      if (prevUse !== undefined) process.env.CHICTR_USE_SIDECAR = prevUse;
      invalidateEnvReport();
    }
  });

  it("sidecar 启用了但不可达时报 missing 并给提示", async () => {
    const prevHome = process.env.CHICTR_HOME;
    const prevUse = process.env.CHICTR_USE_SIDECAR;
    const prevUrl = process.env.CHICTR_SIDECAR_URL;
    process.env.CHICTR_HOME = sandbox;
    process.env.CHICTR_USE_SIDECAR = "1";
    // 指向一个几乎不可能有服务的端口，避免误连真实 sidecar。
    process.env.CHICTR_SIDECAR_URL = "http://127.0.0.1:59999";
    invalidateEnvReport();
    try {
      const report = await getEnvReport(true);
      assert.strictEqual(report.sidecar.status, "missing");
      assert.ok(report.sidecar.hint, "应给出启动 sidecar 的提示");
    } finally {
      if (prevHome === undefined) delete process.env.CHICTR_HOME;
      else process.env.CHICTR_HOME = prevHome;
      if (prevUse === undefined) delete process.env.CHICTR_USE_SIDECAR;
      else process.env.CHICTR_USE_SIDECAR = prevUse;
      if (prevUrl === undefined) delete process.env.CHICTR_SIDECAR_URL;
      else process.env.CHICTR_SIDECAR_URL = prevUrl;
      invalidateEnvReport();
    }
  });
});

describe("Python 版本下限", () => {
  /**
   * 回归用例：曾经 probeVenv 对任何 Python 版本都返回 ok，
   * 导致装了 Python 3.9 的机器被告知「环境就绪」，直到 setup 才莫名失败。
   * 这类假阳性正是本文件存在的理由。
   */
  it("低于 3.10 的 venv 应报 outdated（而非 ok）", async () => {
    const prevHome = process.env.CHICTR_HOME;
    const dir = path.join(sandbox, "old-venv-case");
    const binDir = path.join(dir, ".venv", "bin");
    mkdirSync(binDir, { recursive: true });

    // 造一个假 python：--version 输出 3.9.18，即可触发版本判定分支。
    const fakePython = path.join(binDir, "python3");
    writeFileSync(fakePython, '#!/bin/sh\necho "Python 3.9.18"\n', { mode: 0o755 });

    process.env.CHICTR_HOME = dir;
    invalidateEnvReport();
    try {
      const report = await getEnvReport(true);
      assert.strictEqual(
        report.venv.status,
        "outdated",
        `Python 3.9 不应被判定为就绪，实际: ${report.venv.status} (${report.venv.detail})`
      );
      assert.ok(report.venv.hint, "应给出升级 Python 的提示");
    } finally {
      if (prevHome === undefined) delete process.env.CHICTR_HOME;
      else process.env.CHICTR_HOME = prevHome;
      invalidateEnvReport();
    }
  });

  it("满足 3.10+ 的 venv 应报 ok", async () => {
    const prevHome = process.env.CHICTR_HOME;
    const dir = path.join(sandbox, "new-venv-case");
    const binDir = path.join(dir, ".venv", "bin");
    mkdirSync(binDir, { recursive: true });

    const fakePython = path.join(binDir, "python3");
    writeFileSync(fakePython, '#!/bin/sh\necho "Python 3.10.11"\n', { mode: 0o755 });

    process.env.CHICTR_HOME = dir;
    invalidateEnvReport();
    try {
      const report = await getEnvReport(true);
      assert.strictEqual(report.venv.status, "ok", report.venv.detail);
      assert.strictEqual(report.pythonVersion, "3.10.11");
    } finally {
      if (prevHome === undefined) delete process.env.CHICTR_HOME;
      else process.env.CHICTR_HOME = prevHome;
      invalidateEnvReport();
    }
  });
});

describe("结果缓存", () => {
  it("缓存命中时返回同一对象（避免重复起子进程）", async () => {
    invalidateEnvReport();
    const a = await getEnvReport(true);
    const b = await getEnvReport(false);
    assert.strictEqual(a, b, "30 秒内应命中缓存");
  });

  it("invalidateEnvReport 后强制重新探测", async () => {
    const a = await getEnvReport(true);
    invalidateEnvReport();
    const b = await getEnvReport(false);
    assert.notStrictEqual(a, b, "缓存失效后应产生新对象");
  });
});
describe("formatEnvReport", () => {
  it("渲染包含各项结论，且不泄露 undefined", () => {
    const fake: EnvReport = {
      root: sandbox,
      platform: "darwin",
      node: { status: "ok", detail: "Node 22.19.0" },
      venv: { status: "missing", detail: "未找到虚拟环境", hint: "运行 setup" },
      pythonVersion: null,
      pythonDeps: { status: "unknown", detail: "无虚拟环境，跳过依赖检查" },
      browser: { status: "unknown", detail: "无虚拟环境，跳过浏览器检查" },
      playwrightBrowser: { status: "missing", detail: "未安装" },
      sidecarScript: { status: "ok", detail: "sidecar 脚本已就位" },
      sidecar: { status: "unknown", detail: "未启用 sidecar" },
      summary: "环境未就绪，需要 1 项动作",
      actions: ["运行 setup"],
      canRunBrowserless: false,
    };

    const text = formatEnvReport(fake);
    assert.ok(text.includes("Node 22.19.0"));
    assert.ok(text.includes("运行 setup"));
    assert.ok(text.includes(fake.summary));
    assert.ok(!text.includes("undefined"), "渲染文本不应出现 undefined");
    // ✅/❌/➖ 三种状态图标都应出现，便于用户一眼扫读。
    assert.ok(text.includes("✅") && text.includes("❌") && text.includes("➖"));
  });
});
