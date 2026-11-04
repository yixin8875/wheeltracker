"""Windows native Tauri acceptance using real WebDriver, IPC and isolated SQLite.
Run: python -I scripts/desktop_acceptance.py (see docs/desktop-acceptance.md).
"""
import argparse
import base64
import datetime as dt
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
ELEMENT = "element-6066-11e4-a52e-4f735466cecf"


class WebDriver:
    def __init__(self, port):
        self.url = f"http://127.0.0.1:{port}"
        self.session = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, route, data=None):
        payload = None if data is None else json.dumps(data).encode("utf-8")
        req = urllib.request.Request(self.url + route, data=payload, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with self.http.open(req, timeout=65) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode("utf-8", "replace")) from error
        value = result.get("value")
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(str(value))
        return value

    def command(self, method, route, data=None):
        return self.request(method, f"/session/{self.session}" + route, data)

    def start(self, application):
        value = self.request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "browserName": "wry", "tauri:options": {"application": str(application)}
        }}})
        self.session = value["sessionId"]
        self.command("POST", "/timeouts", {"script": 30000, "implicit": 0})
        self.wait(lambda: self.js("return !!window.__TAURI_INTERNALS__ && !!document.querySelector('nav');"))
        self.wait(lambda: self.invoke("get_settings"))

    def stop(self):
        if self.session:
            try:
                self.command("DELETE", "")
            finally:
                self.session = None

    def js(self, script, *args):
        return self.command("POST", "/execute/sync", {"script": script, "args": list(args)})

    def invoke(self, command, args=None):
        result = self.command("POST", "/execute/async", {"script": """
            const done = arguments[arguments.length - 1];
            window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1] || {})
                .then(value => done({ok: true, value}))
                .catch(error => done({ok: false, error: String(error)}));
            """, "args": [command, args]})
        if not result["ok"]:
            raise RuntimeError(result["error"])
        return result["value"]

    def wait(self, predicate, timeout=25):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                value = predicate()
                if value:
                    return value
            except (RuntimeError, urllib.error.URLError) as error:
                last = error
            time.sleep(0.15)
        raise AssertionError(f"Timed out waiting for native UI: {last}")

    def element(self, selector):
        return self.command("POST", "/element", {"using": "css selector", "value": selector})

    def click(self, element):
        self.js("arguments[0].scrollIntoView({block:'center'});", element)
        self.command("POST", f"/element/{element[ELEMENT]}/click", {})

    def text_click(self, selector, text):
        element = self.wait(lambda: self.js("""
            return [...document.querySelectorAll(arguments[0])]
                .find(e => e.textContent.trim() === arguments[1]) || null;
            """, selector, text))
        self.click(element)

    def field(self, label, value):
        self.js("""
            const label = [...document.querySelectorAll('label')].find(e =>
                [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim() === arguments[0]));
            const input = label?.control || label?.querySelector('input,select,textarea');
            if (!input) throw new Error('Missing field: ' + arguments[0]);
            const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
                input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, String(arguments[1]));
            input.dispatchEvent(new Event('input', {bubbles:true}));
            input.dispatchEvent(new Event('change', {bubbles:true}));
            """, label, value)

    def body(self):
        return self.js("return document.body.innerText;")

    def screenshot(self, path):
        path.write_bytes(base64.b64decode(self.command("GET", "/screenshot")))


def checked(condition, message):
    if not condition:
        raise AssertionError(message)


def near(actual, expected):
    checked(actual is not None and abs(actual - expected) < 0.00001,
            f"Expected {expected}, got {actual}")


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def run(args):
    if os.name != "nt":
        raise RuntimeError("This acceptance runner requires Windows + WebView2")
    checked(args.driver.is_file() and args.edge_driver.is_file(), "Install tauri-driver and matching EdgeDriver first")
    run_id = "t" + dt.datetime.now().strftime("%Y%m%d%H%M%S") + uuid.uuid4().hex[:6]
    output = ROOT / "target" / "desktop-acceptance" / run_id
    output.mkdir(parents=True, exist_ok=False)
    identifier = "com.wheeltracker.acceptance." + run_id
    config = output / "tauri.acceptance.json"
    config.write_text(json.dumps({
        "productName": "Wheel Acceptance " + run_id,
        "identifier": identifier,
        "app": {"windows": [{"title": "Wheel Tracker — 验收专用 " + run_id,
                               "width": 1280, "height": 900}]},
        "bundle": {"windows": {"nsis": {"installMode": "currentUser"}}}
    }), encoding="utf-8")
    report = {"runId": run_id, "identifier": identifier,
              "startedAt": dt.datetime.now().isoformat(), "cases": [], "output": str(output)}
    driver = WebDriver(free_port())
    process = None
    driver_log = None
    application = None
    installed = None
    uninstall = None
    needs_uninstall = False
    profile = "release" if args.release else "debug"
    report["profile"] = profile
    env = os.environ.copy()
    env["CARGO_TARGET_DIR"] = str(ROOT / "target" / "native-acceptance-build")
    for key in list(env):
        if key.lower() in ("http_proxy", "https_proxy", "all_proxy"):
            del env[key]
    env["CARGO_HTTP_PROXY"] = ""

    def record(name, details):
        report["cases"].append({"name": name, "status": "passed", "details": details})
        print("PASS " + name + ": " + details, flush=True)

    def events():
        return driver.invoke("list_events")

    def campaign():
        return driver.invoke("dashboard")["campaigns"][0]

    def entry(kind, date, *, price=None, qty=1, expiry="2026-02-20", strike=100,
              right="P", fees=0, note="", roll=None, reject=False):
        before = len(events())
        driver.text_click("nav button", "记一笔Ctrl N")
        driver.field("交易类型", kind)
        driver.field("交易日期", date)
        driver.field("标的代码", "ZZWHEEL")
        driver.field("手数" if kind.startswith("option_") else "股数", qty)
        if kind.startswith("option_"):
            driver.field("到期日", expiry)
            driver.field("期权方向", right)
            driver.field("行权价", strike)
        if price is not None:
            driver.field("每股权利金 / 平仓价" if kind.startswith("option_") else
                         "每股分红" if kind == "dividend" else "每股成交价", price)
        if kind not in ("option_expire", "dividend"):
            driver.field("费用总额", fees)
        driver.field("备注", note)
        if roll:
            driver.click(driver.element(".entry-panel > form > label.check input"))
            for label, value in zip(("新到期日", "新行权价", "新每股权利金", "新开仓费用"), roll):
                driver.field(label, value)
        driver.click(driver.element("button[type=submit]"))
        if reject:
            driver.wait(lambda: "保存失败" in driver.body())
            checked(len(events()) == before, "Rejected entry wrote an event")
        else:
            driver.wait(lambda: len(events()) == before + (2 if roll else 1))
            driver.wait(lambda: driver.js("return document.querySelector('button[type=submit]')?.textContent === '已保存';"))

    def history():
        driver.text_click("nav button", "设置")
        driver.text_click(".settings-tabs button", "交易记录")

    def undo(note, reject=False):
        before = len(events())
        history()
        row = driver.js("return [...document.querySelectorAll('tbody tr')].find(e => e.innerText.includes(arguments[0]));", note)
        checked(row is not None, "Missing history note " + note)
        driver.click(driver.js("return arguments[0].querySelector('button');", row))
        driver.text_click("[role=dialog] button", "确认撤销")
        if reject:
            driver.wait(lambda: driver.js("return !!document.querySelector('main > .alert.error');"))
            checked(len(events()) == before, "Dependency rejection changed history")
            driver.text_click("[role=dialog] button", "取消")
            driver.text_click("main > .alert.error button", "关闭")
        else:
            driver.wait(lambda: len(events()) == before - 1)

    try:
        with (output / "build.log").open("w", encoding="utf-8") as log:
            command = ["npm.cmd", "--prefix", "ui", "run", "desktop:build", "--"]
            if profile == "debug":
                command.append("--debug")
            command.extend(["--bundles", "nsis", "--config", str(config)])
            subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                           check=True, timeout=900)
        record("acceptance-installer-build", profile.title() + " NSIS built with unique application identifier")
        bundles = list((Path(env["CARGO_TARGET_DIR"]) / profile / "bundle" / "nsis")
                       .glob(f"Wheel Acceptance {run_id}_*.exe"))
        checked(len(bundles) == 1, "Expected exactly one installer for this run")
        installer = bundles[0]
        installed = output / "installed"
        application = installed / "wheel-app.exe"
        uninstall = installed / "uninstall.exe"
        needs_uninstall = True
        result = subprocess.run([str(installer), "/S", "/D=" + str(installed)], timeout=120, check=False)
        checked(result.returncode == 0, f"Installer exit {result.returncode}")
        checked(application.is_file(), "Installed executable is missing")
        checked(uninstall.is_file(), "Uninstaller is missing")
        report["installer"] = str(installer)
        report["installedApplication"] = str(application)
        record("silent-install", "Installed acceptance build in dedicated per-run directory")
        driver_log = (output / "webdriver.log").open("w", encoding="utf-8")
        process = subprocess.Popen([str(args.driver.resolve()), "--port", str(driver.url.rsplit(":", 1)[1]),
                                    "--native-port", str(free_port()), "--native-driver", str(args.edge_driver.resolve())],
                                   cwd=ROOT, env=env, stdout=driver_log, stderr=subprocess.STDOUT)
        driver.wait(lambda: driver.request("GET", "/status"), timeout=20)
        driver.start(application)
        info = driver.invoke("app_info")
        database = Path(info["dbPath"])
        checked(identifier in str(database), "Refusing to test a non-isolated database")
        checked(len(events()) == 0, "Acceptance database must start empty")
        report["database"] = str(database)
        driver.screenshot(output / "01-empty.png")
        record("installed-native-launch", "Real WebView2 and IPC; fresh isolated SQLite: " + str(database))

        entry("option_open_short", "2026-01-02", price=2, fees=1, note="first-put")
        near(campaign()["premiumOpen"], 199)
        near(driver.invoke("dashboard")["summary"]["collateral"], 10000)
        checked(events()[0]["seq"] == 1, "First event sequence is not 1")
        record("first-record", "First native UI save persisted sequence 1; open premium $199, collateral $10,000")
        entry("option_expire", "2026-02-20", note="put-expired")
        near(campaign()["premiumRealized"], 199)
        checked(not driver.invoke("positions"), "Expired Put remains open")
        record("put-expiry", "Expiry realizes $199 and releases collateral")

        entry("option_open_short", "2026-03-02", price=3, expiry="2026-03-20", fees=1, note="assigned-put-open")
        entry("option_assign", "2026-03-20", expiry="2026-03-20", fees=1, note="put-assigned")
        checked(campaign()["shares"] == 100, "Put assignment shares")
        near(campaign()["costA"], 100.01)
        near(campaign()["costB"], 95.03)
        record("put-assignment", "100 shares; A $100.01, B $95.03 including previous realized premium")
        entry("dividend", "2026-03-23", price=0.5, qty=100, note="dividend")
        driver.text_click("nav button", "设置")
        driver.text_click(".settings-tabs button", "成本口径")
        driver.click(driver.element(".accounting-preferences input[type=checkbox]"))
        driver.text_click(".accounting-preferences button", "保存成本设置")
        driver.wait(lambda: driver.invoke("get_settings")["includeDividendsInCost"])
        near(campaign()["costB"], 94.53)
        record("dividend-setting", "UI setting persists through IPC; dividend reduces B by $0.50/share")

        entry("option_open_short", "2026-03-24", price=2, right="C", strike=110, expiry="2026-04-17", fees=1, note="call-open")
        entry("option_close", "2026-03-25", price=0.5, right="C", strike=110, expiry="2026-04-17", fees=1,
              note="roll-close", roll=("2026-05-15", 115, 2.5, 1))
        near(campaign()["premiumRealized"], 646)
        near(campaign()["premiumOpen"], 249)
        checked(driver.invoke("positions")[0]["strike"] == 115, "Roll did not replace contract")
        record("atomic-roll", "Two UI-submitted legs persist; realized premium $646, new open premium $249")
        before = events()
        req = {"date": "2026-03-26", "kind": "option_close", "symbol": "ZZWHEEL", "qty": 1,
               "price": 0.5, "fees": 0, "expiry": "2026-05-15", "strike": 115, "right": "C"}
        try:
            driver.invoke("add_events", {"reqs": [req, {**req, "kind": "option_open_short", "price": -1}]})
        except RuntimeError as error:
            checked("nonnegative" in str(error), "Unexpected rejection reason: " + str(error))
        else:
            raise AssertionError("Invalid roll unexpectedly succeeded")
        checked(events() == before, "Invalid native IPC roll partially committed")
        near(campaign()["premiumOpen"], 249)
        record("invalid-roll-rollback", "Real IPC invalid second leg rejects both writes and preserves open position")
        undo("assigned-put-open", reject=True)
        record("dependent-undo-rejected", "Native confirmation rejects removing Put open beneath assignment")
        cost_before_undo = campaign()["costB"]
        undo("dividend")
        near(campaign()["costB"], cost_before_undo + 0.5)
        entry("dividend", "2026-03-23", price=0.5, qty=100, note="restored-dividend")
        record("valid-undo", "UI undo recomputes dividend costs and preserves soft-deleted audit row")
        entry("option_expire", "2026-05-15", right="C", strike=115, expiry="2026-05-15", note="call-expired")
        near(campaign()["premiumRealized"], 895)
        record("call-close-and-expiry", "Close/expiry fully realize $895 cumulative net option premium")

        entry("option_open_short", "2026-05-18", price=1, right="C", strike=110, expiry="2026-06-19", fees=1, note="final-call")
        detail = driver.invoke("campaign_detail", {"campaignId": campaign()["id"]})
        near(detail["callScenarios"][0]["realizedTotal"], 2043)
        driver.text_click("nav button", "仪表盘")
        driver.text_click(".campaign-card button", "查看战役")
        driver.wait(lambda: "$2,043.00" in driver.js("return document.querySelector('.call-scenarios')?.innerText || '';"))
        near(campaign()["costC"], 89.57)
        driver.js("document.querySelector('.call-scenarios').scrollIntoView({block:'center'});")
        driver.screenshot(output / "02-call-scenario.png")
        record("call-assignment-preview", "Real detail UI renders no-write scenario, projected total P&L $2,043")
        entry("option_assign", "2026-06-19", right="C", strike=110, expiry="2026-06-19", fees=1, note="call-assigned")
        checked(campaign()["status"] == "closed" and campaign()["shares"] == 0, "Call assignment did not settle campaign")
        near(campaign()["realizedPnl"], 2042)
        record("call-assignment", "Campaign closes; total realized P&L $2,042 after $1 assignment fee")

        driver.invoke("set_price", {"symbol": "ZZWHEEL", "date": "2026-06-19", "close": 111})
        before_restart = {key: driver.invoke(key) for key in ("dashboard", "list_events", "get_settings", "list_prices")}
        driver.stop()
        driver.start(application)
        checked(driver.invoke("app_info")["dbPath"] == str(database), "Restart changed database")
        for key, value in before_restart.items():
            checked(driver.invoke(key) == value, "Restart changed " + key)
        record("restart-persistence", "Installed app restarted; events, derived balances, settings and price metadata retained")
        driver.text_click("nav button", "设置")
        driver.text_click(".settings-tabs button", "备份与维护")
        driver.text_click(".toolbar button", "重算并检查账本")
        driver.wait(lambda: "检查通过" in driver.body())
        driver.text_click(".toolbar button", "备份 SQLite")
        driver.wait(lambda: "备份已保存" in driver.body())
        snapshots = list((database.parent / "backups").glob("*.sqlite"))
        checked(len(snapshots) == 1, "Expected one UI-created snapshot")
        snapshot = snapshots[0]
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as source, \
                sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True) as backup:
            checked(backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "Backup integrity failed")
            for table in ("events", "prices", "settings", "accounts"):
                checked(source.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall() ==
                        backup.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall(), "Backup mismatch " + table)
            checked(backup.execute("SELECT count(*) FROM events WHERE deleted_at IS NOT NULL").fetchone()[0] == 1,
                    "Backup lost soft-deleted audit history")
        report["backup"] = str(snapshot)
        driver.screenshot(output / "03-backup.png")
        record("rebuild-and-backup", "UI rebuild passes; backup integrity, events, audit history, settings and prices match SQLite")
        driver.stop()
        # NSIS _?= waits for the real uninstaller instead of a detached copy.
        result = subprocess.run([str(uninstall), "/S", "_?=" + str(installed)], timeout=90, check=False)
        checked(result.returncode == 0 and not application.exists(), "Silent uninstall failed")
        checked(database.exists(), "Uninstall removed ledger data")
        needs_uninstall = False
        record("silent-uninstall", "Acceptance executable removed; isolated ledger retained")
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        if driver.session:
            try:
                driver.screenshot(output / "failure.png")
                (output / "failure.txt").write_text(driver.body(), encoding="utf-8")
            except Exception:
                pass
        raise
    finally:
        cleanup_errors = []
        try:
            driver.stop()
        except Exception as error:
            cleanup_errors.append("WebDriver session: " + str(error))
        if process:
            try:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
            except Exception as error:
                cleanup_errors.append("Driver process: " + str(error))
        if driver_log:
            driver_log.close()
        if needs_uninstall:
            try:
                checked(uninstall is not None and uninstall.is_file(), "Acceptance uninstaller missing")
                result = subprocess.run([str(uninstall), "/S", "_?=" + str(installed)], timeout=90, check=False)
                checked(result.returncode == 0 and not application.exists(), "Acceptance uninstall failed")
                report["failureCleanup"] = "Acceptance application uninstalled; test ledger retained"
            except Exception as error:
                cleanup_errors.append("Acceptance uninstall: " + str(error))
        if cleanup_errors:
            report["cleanupErrors"] = cleanup_errors
            report["status"] = "failed"
        report["finishedAt"] = dt.datetime.now().isoformat()
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("REPORT " + str(output / "report.json"), flush=True)
        if cleanup_errors and "error" not in report:
            raise RuntimeError("Acceptance cleanup failed: " + "; ".join(cleanup_errors))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true", help="Test optimized Release instead of Debug build")
    parser.add_argument("--driver", type=Path, default=ROOT / "target/native-tools/bin/tauri-driver.exe")
    parser.add_argument("--edge-driver", type=Path, default=ROOT / "target/native-tools/edge-156/msedgedriver.exe")
    run(parser.parse_args())
