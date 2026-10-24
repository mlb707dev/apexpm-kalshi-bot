"""
ApexPM Trading Bot — Kalshi Live Execution Engine
Strategies: YES/NO arb, multi-outcome arb, cross-platform (Polymarket oracle), lottery
Auth: RSA-PSS signed requests (Kalshi API v2)
"""

import os
import time
import json
import math
import base64
import logging
import sqlite3
import schedule
import datetime
import requests
import threading
from typing import Optional
from dotenv import load_dotenv
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding

try:
    import websocket as _ws_mod
    HAS_WEBSOCKET = True
except ImportError:
    HAS_WEBSOCKET = False

load_dotenv()

# ─── LOGGING ──────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("apexpm.log"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger(__name__)

# ─── CONFIG FROM ENV ──────────────────────────────────────────
API_KEY_ID      = os.getenv("KALSHI_API_KEY_ID", "")
PRIVATE_KEY_PEM = os.getenv("KALSHI_PRIVATE_KEY_PEM", "").replace("\\n", "\n")
BANKROLL        = float(os.getenv("BANKROLL", "500"))
DRY_RUN         = os.getenv("DRY_RUN", "true").lower() == "true"  # safety default
REPORT_EMAIL    = os.getenv("REPORT_EMAIL", "")
SENDGRID_KEY    = os.getenv("SENDGRID_API_KEY", "")
EMAIL_ENABLED   = os.getenv("EMAIL_ENABLED", "false").lower() == "true"

# Production vs Demo
USE_DEMO        = os.getenv("USE_DEMO", "false").lower() == "true"
BASE_URL        = "https://demo-api.kalshi.co/trade-api/v2" if USE_DEMO else \
                  "https://api.elections.kalshi.com/trade-api/v2"

# ─── STRATEGY PARAMETERS ──────────────────────────────────────
# Public defaults: deliberately conservative, round numbers chosen for
# readability, NOT tuned values. Every knob can be overridden from the
# environment (see .env.example) so you can tune without editing code.
def _f(name, default): return float(os.getenv(name, default))
def _i(name, default): return int(os.getenv(name, default))

# Sizing & risk
KELLY_FRACTION   = _f("KELLY_FRACTION", "0.25")    # fractional Kelly (full Kelly is too aggressive)
MAX_POS_PCT      = _f("MAX_POS_PCT", "0.05")       # max share of bankroll per position
MAX_TRADE_USD    = _f("MAX_TRADE_USD", "10")       # hard cap per trade while balance < SAFE_BALANCE
MAX_CONTRACTS    = _i("MAX_CONTRACTS", "25")       # hard cap contracts per order while balance < SAFE_BALANCE
SAFE_BALANCE     = _f("SAFE_BALANCE", str(BANKROLL))  # above this, normal Kelly sizing resumes
MAX_POSITIONS    = _i("MAX_POSITIONS", "3")        # max concurrent open positions
MAX_EVENT_PCT    = _f("MAX_EVENT_PCT", "0.10")     # max share of balance deployed in one event arb
STOP_LOSS_COOLDOWN = _i("STOP_LOSS_COOLDOWN", "3600")  # seconds before a stop loss may trigger

# Entry filters
MIN_EDGE_CENTS   = _i("MIN_EDGE_CENTS", "3")       # min edge (cents) for YES/NO arb
MIN_EVENT_EDGE   = _i("MIN_EVENT_EDGE", "5")       # min edge (cents) for event arb
MIN_TRADE_PROFIT = _f("MIN_TRADE_PROFIT", "2")     # reject event arb if expected profit is below this ($)
MIN_VOLUME_24H   = _i("MIN_VOLUME_24H", "100")     # min 24h volume for a market
MIN_LEG_VOL24H   = _i("MIN_LEG_VOL24H", "100")     # min 24h volume per event-arb leg
MAX_LEG_SPREAD   = _i("MAX_LEG_SPREAD", "5")       # max bid-ask spread (cents) per leg

# Loop & exits
SCAN_INTERVAL    = _i("SCAN_INTERVAL", "30")       # seconds between scans
CONVERGENCE_PCT  = _f("CONVERGENCE_PCT", "0.75")   # exit once this share of max profit is captured
TARGET_EXIT_DAYS = _i("TARGET_EXIT_DAYS", "7")     # plan to exit within N days or at convergence

# Events to never trade (illiquid / stuck / untradeable). Comma-separated tickers.
EVENT_BLACKLIST = {t.strip() for t in os.getenv("EVENT_BLACKLIST", "").split(",") if t.strip()}

# Active strategies. Event arb ships disabled: it is the riskiest leg-by-leg fill.
STRATEGIES = {
    "yes_no_arb":     True,
    "multi_arb":      True,   # multi-outcome event arb (sum of YES asks < 100c - edge)
    "cross_platform": True,   # needs CROSS_PLATFORM_PAIRS filled in below
    "event_arb":      False,
    "lottery":        False,  # speculative; opt in deliberately
}

# Multi-outcome arb
MULTI_ARB_MIN_EDGE    = _i("MULTI_ARB_MIN_EDGE", "3")      # min edge (cents)
MULTI_ARB_MIN_LEGS    = _i("MULTI_ARB_MIN_LEGS", "3")      # need at least N outcomes
MULTI_ARB_MIN_VOL_LEG = _i("MULTI_ARB_MIN_VOL_LEG", "100") # min 24h volume per leg
MULTI_ARB_MAX_COST    = _f("MULTI_ARB_MAX_COST", "10")     # max $ across all legs

# Category sweeps (public Kalshi series tickers)
MULTI_ARB_SERIES = [
    "KXBTC", "KXETH",                                 # Crypto
    "KXFED", "KXCPI", "KXGDP",                        # Economics
    "KXNFL", "KXNBA", "KXMLB", "KXNHL", "KXSOCCER",   # Sports
    "KXPRES", "KXSENATE", "KXHOUSE", "KXGOV",         # Politics
]
MULTI_ARB_BROAD_PAGES  = _i("MULTI_ARB_BROAD_PAGES", "4")   # pages of 50 events for the broad sweep
MULTI_ARB_SERIES_PAGES = _i("MULTI_ARB_SERIES_PAGES", "2")  # pages per series sweep

# Lottery tickets (low-priced, high-volume contracts)
LOTTERY_MAX_YES_ASK   = _i("LOTTERY_MAX_YES_ASK", "5")       # max YES ask (cents)
LOTTERY_MIN_VOL_24H   = _i("LOTTERY_MIN_VOL_24H", "1000")    # min 24h volume
LOTTERY_ALERT_VOL_24H = _i("LOTTERY_ALERT_VOL_24H", "5000")  # volume that gets a louder log line
LOTTERY_MAX_TRADE_USD = _f("LOTTERY_MAX_TRADE_USD", "2")     # hard cap per ticket ($)
LOTTERY_MAX_CONTRACTS = _i("LOTTERY_MAX_CONTRACTS", "50")    # hard cap contracts per ticket
LOTTERY_MAX_PER_SCAN  = _i("LOTTERY_MAX_PER_SCAN", "1")      # max tickets per scan cycle

# ─── DATABASE SETUP ───────────────────────────────────────────
def init_db():
    conn = sqlite3.connect("apexpm.db")
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            ts INTEGER,
            market TEXT,
            ticker TEXT,
            strategy TEXT,
            side TEXT,
            contracts INTEGER,
            entry_yes_cents INTEGER,
            entry_no_cents INTEGER,
            exit_yes_cents INTEGER,
            exit_no_cents INTEGER,
            edge_pct REAL,
            fill_rate REAL,
            profit_cents INTEGER,
            status TEXT,
            notes TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS daily_reports (
            date TEXT PRIMARY KEY,
            trades INTEGER,
            wins INTEGER,
            losses INTEGER,
            gross_pnl_cents INTEGER,
            fees_cents INTEGER,
            net_pnl_cents INTEGER,
            win_rate REAL,
            best_trade TEXT,
            worst_trade TEXT,
            report_json TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS missed_opportunities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER,
            ticker TEXT,
            event_ticker TEXT,
            strategy TEXT,
            edge_cents REAL,
            reason TEXT,
            details TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS market_scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_ts INTEGER,
            ticker TEXT,
            yes_bid INTEGER,
            yes_ask INTEGER,
            no_bid INTEGER,
            no_ask INTEGER,
            spread INTEGER,
            volume_24h REAL,
            volume_total INTEGER,
            last_price INTEGER,
            edge_cents REAL,
            strategy TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS opportunities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_ts INTEGER,
            ticker TEXT,
            event_ticker TEXT,
            strategy TEXT,
            arb_type TEXT,
            side TEXT,
            edge_cents REAL,
            edge_per_day REAL,
            n_legs INTEGER,
            sum_cost_cents INTEGER,
            contracts INTEGER,
            profit_usd REAL,
            days_to_exp REAL,
            taken INTEGER DEFAULT 0,
            rejection_reason TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS scan_summary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_ts INTEGER,
            balance_usd REAL,
            session_pnl_usd REAL,
            markets_fetched INTEGER,
            markets_with_edge INTEGER,
            opportunities_found INTEGER,
            opportunities_taken INTEGER,
            strategies_active TEXT,
            held_events INTEGER,
            held_tickers INTEGER,
            scan_duration_ms INTEGER
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS exit_targets (
            ticker TEXT PRIMARY KEY,
            trade_id TEXT,
            event_ticker TEXT,
            side TEXT,
            contracts INTEGER,
            entry_price INTEGER,
            entry_vol REAL,
            entry_ts INTEGER,
            target_exit INTEGER,
            momentum_exit INTEGER,
            stop_loss INTEGER,
            max_hold_ts INTEGER
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS trade_exits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id TEXT,
            exit_ts INTEGER,
            ticker TEXT,
            side TEXT,
            contracts INTEGER,
            entry_price_cents INTEGER,
            exit_price_cents INTEGER,
            hold_time_hours REAL,
            profit_cents INTEGER,
            profit_usd REAL,
            exit_reason TEXT,
            plan_target_cents INTEGER,
            plan_stop_cents INTEGER,
            hit_plan INTEGER DEFAULT 1
        )
    """)
    # Weekly stats view for AI analysis
    c.execute("DROP VIEW IF EXISTS weekly_stats")
    c.execute("""
        CREATE VIEW weekly_stats AS
        SELECT
            strftime('%Y-W%W', ts, 'unixepoch') AS week,
            COUNT(*) AS total_trades,
            SUM(CASE WHEN profit_cents > 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN profit_cents < 0 THEN 1 ELSE 0 END) AS losses,
            ROUND(100.0 * SUM(CASE WHEN profit_cents > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate_pct,
            SUM(profit_cents) AS gross_pnl_cents,
            ROUND(SUM(profit_cents) / 100.0, 2) AS gross_pnl_usd,
            ROUND(
                CASE WHEN SUM(CASE WHEN profit_cents < 0 THEN ABS(profit_cents) ELSE 0 END) > 0
                THEN 1.0 * SUM(CASE WHEN profit_cents > 0 THEN profit_cents ELSE 0 END)
                     / SUM(CASE WHEN profit_cents < 0 THEN ABS(profit_cents) ELSE 0 END)
                ELSE 0 END, 2
            ) AS profit_factor,
            ROUND(AVG(edge_pct) * 100, 2) AS avg_edge_pct,
            strategy AS top_strategy,
            MIN(profit_cents) AS worst_trade_cents,
            MAX(profit_cents) AS best_trade_cents
        FROM trades
        WHERE status != 'open'
        GROUP BY week, strategy
        ORDER BY week DESC
    """)
    conn.commit()
    conn.close()

def log_missed(ticker: str, event_ticker: str, strategy: str,
               edge_cents: float, reason: str, details: str = ""):
    """Record a rejected opportunity for pattern analysis."""
    try:
        conn = sqlite3.connect("apexpm.db")
        c = conn.cursor()
        c.execute("""
            INSERT INTO missed_opportunities (ts, ticker, event_ticker, strategy, edge_cents, reason, details)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (int(time.time()), ticker, event_ticker, strategy, edge_cents, reason, details))
        conn.commit()
        conn.close()
    except Exception:
        pass  # never let logging break the bot

def log_trade(trade: dict):
    conn = sqlite3.connect("apexpm.db")
    c = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO trades VALUES (
            :id, :ts, :market, :ticker, :strategy, :side,
            :contracts, :entry_yes_cents, :entry_no_cents,
            :exit_yes_cents, :exit_no_cents,
            :edge_pct, :fill_rate, :profit_cents, :status, :notes
        )
    """, trade)
    conn.commit()
    conn.close()

def log_market_scans(scan_ts: int, markets: list, strategy: str):
    """Bulk-insert scanned market snapshots."""
    try:
        conn = sqlite3.connect("apexpm.db")
        c = conn.cursor()
        rows = []
        for m in markets:
            ya = m.get("yes_ask", 0)
            yb = m.get("yes_bid", 0)
            rows.append((
                scan_ts, m.get("ticker", ""), yb, ya,
                m.get("no_bid", 0), m.get("no_ask", 0),
                ya - yb if ya and yb else 0,
                m.get("vol24h", m.get("volume_24h", 0)),
                m.get("volume", 0),
                m.get("last_price", 0),
                m.get("edge", 100 - ya - m.get("no_ask", 0) if ya else 0),
                strategy,
            ))
        c.executemany("""
            INSERT INTO market_scans
            (scan_ts, ticker, yes_bid, yes_ask, no_bid, no_ask, spread,
             volume_24h, volume_total, last_price, edge_cents, strategy)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, rows)
        conn.commit()
        conn.close()
    except Exception:
        pass

def log_opportunity(scan_ts: int, opp: dict, taken: bool, rejection_reason: str = ""):
    """Log an opportunity (taken or rejected) for analysis."""
    try:
        conn = sqlite3.connect("apexpm.db")
        c = conn.cursor()
        c.execute("""
            INSERT INTO opportunities
            (scan_ts, ticker, event_ticker, strategy, arb_type, side,
             edge_cents, edge_per_day, n_legs, sum_cost_cents, contracts,
             profit_usd, days_to_exp, taken, rejection_reason)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            scan_ts,
            opp.get("ticker", ""),
            opp.get("event_ticker", ""),
            opp.get("strategy", ""),
            opp.get("arb_type", ""),
            opp.get("side", ""),
            opp.get("edge_cents", 0),
            opp.get("edge_per_day", 0),
            opp.get("n_markets", opp.get("n_legs", 1)),
            opp.get("sum_cost", 0),
            opp.get("contracts", 0),
            opp.get("profit_usd", 0),
            opp.get("days_to_exp", 0),
            1 if taken else 0,
            rejection_reason,
        ))
        conn.commit()
        conn.close()
    except Exception:
        pass

def log_scan_summary(scan_ts: int, balance: float, pnl: float,
                     markets_fetched: int, markets_with_edge: int,
                     opps_found: int, opps_taken: int,
                     strategies: str, duration_ms: int):
    """Log aggregate stats for one scan cycle."""
    try:
        conn = sqlite3.connect("apexpm.db")
        c = conn.cursor()
        c.execute("""
            INSERT INTO scan_summary
            (scan_ts, balance_usd, session_pnl_usd, markets_fetched,
             markets_with_edge, opportunities_found, opportunities_taken,
             strategies_active, held_events, held_tickers, scan_duration_ms)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (scan_ts, balance, pnl, markets_fetched, markets_with_edge,
              opps_found, opps_taken, strategies, len(held_events),
              len(held_tickers), duration_ms))
        conn.commit()
        conn.close()
    except Exception:
        pass

# ─── TRADE PLAN SYSTEM ─────────────────────────────────────────
# All exit thresholds are pre-computed at entry time and stored as
# flat integers in exit_targets. The exit checker does zero math —
# just price lookup, integer compare, fire order.

# In-memory exit target table: ticker -> {all thresholds as ints}
_exit_targets = {}  # populated at entry, persisted in SQLite


def create_exit_targets(trade_id: str, opp: dict, side: str,
                        markets: list, contracts: int):
    """
    Pre-compute all exit thresholds at entry time. Stores one flat row
    per leg in _exit_targets (memory) and exit_targets table (SQLite).
    Zero recalculation at exit time.
    """
    now = int(time.time())
    edge = opp.get("edge_cents", 0)
    max_hold_days = 3 if edge < 5 else min(TARGET_EXIT_DAYS, int(opp.get("days_to_exp", 7)))
    max_hold_ts = now + max_hold_days * 86400

    rows = []
    for m in markets:
        ticker = m["ticker"]
        entry_price = m["yes_ask"] if side == "yes" else m["no_ask"]
        entry_vol = m.get("vol24h", 0)
        max_profit = 100 - entry_price  # per leg at resolution

        target = int(entry_price + max_profit * CONVERGENCE_PCT)  # 72%
        momentum = int(entry_price + max_profit * 0.90)           # 90%
        # Low-price legs (<20c) use 50% stop — normal spreads are huge relative to price
        stop_pct = 0.50 if entry_price < 20 else 0.70
        stop = max(1, int(entry_price * stop_pct))

        row = {
            "trade_id":       trade_id,
            "ticker":         ticker,
            "event_ticker":   opp.get("event_ticker", ""),
            "side":           side,
            "contracts":      contracts,
            "entry_price":    entry_price,
            "entry_vol":      entry_vol,
            "entry_ts":       now,
            "target_exit":    target,
            "momentum_exit":  momentum,
            "stop_loss":      stop,
            "max_hold_ts":    max_hold_ts,
        }
        _exit_targets[ticker] = row
        rows.append(row)

    # Persist to SQLite
    try:
        conn = sqlite3.connect("apexpm.db")
        c = conn.cursor()
        for r in rows:
            c.execute("""
                INSERT OR REPLACE INTO exit_targets
                (trade_id, ticker, event_ticker, side, contracts,
                 entry_price, entry_vol, entry_ts,
                 target_exit, momentum_exit, stop_loss, max_hold_ts)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """, (r["trade_id"], r["ticker"], r["event_ticker"],
                  r["side"], r["contracts"], r["entry_price"],
                  r["entry_vol"], r["entry_ts"], r["target_exit"],
                  r["momentum_exit"], r["stop_loss"], r["max_hold_ts"]))
        conn.commit()
        conn.close()
    except Exception as e:
        log.debug(f"Exit targets save error: {e}")

    # Log the plan once
    log.info(f"[PLAN] {trade_id} | {len(rows)} legs | hold<={max_hold_days}d")
    for r in rows:
        log.info(f"  {r['ticker'][:40]:40s} entry={r['entry_price']:2d}c "
                 f"target={r['target_exit']:2d}c mom={r['momentum_exit']:2d}c "
                 f"stop={r['stop_loss']:2d}c")


def load_exit_targets():
    """Load persisted exit targets from SQLite on startup."""
    try:
        conn = sqlite3.connect("apexpm.db")
        c = conn.cursor()
        c.execute("SELECT * FROM exit_targets WHERE 1")
        cols = [d[0] for d in c.description]
        for row in c.fetchall():
            r = dict(zip(cols, row))
            _exit_targets[r["ticker"]] = r
        conn.close()
        if _exit_targets:
            log.info(f"[PLAN] Loaded {len(_exit_targets)} exit targets from DB")
    except Exception:
        pass  # table may not exist yet


# ─── KALSHI AUTH ───────────────────────────────────────────────
class KalshiAuth:
    def __init__(self, key_id: str, private_key_pem: str):
        self.key_id = key_id
        import re, base64 as b64
        pem = private_key_pem.strip()
        b64_key = os.getenv("KALSHI_PRIVATE_KEY_B64", "")
        log.info(f"Auth: key_id={key_id[:8]}... b64_key_len={len(b64_key)} pem_len={len(pem)}")
        if b64_key:
            try:
                pem = b64.b64decode(b64_key).decode("utf-8")
                log.info(f"B64 decoded OK, pem starts: {pem[:40]}")
            except Exception as e:
                log.error(f"B64 decode failed: {e}")
        if "\\n" in pem:
            pem = pem.replace("\\n", "\n")
        if "\n" not in pem:
            match = re.search(r'-----BEGIN ([^-]+)-----(.+?)-----END ([^-]+)-----', pem)
            if match:
                key_type = match.group(1)
                body = match.group(2).strip()
                wrapped = "\n".join(body[i:i+64] for i in range(0, len(body), 64))
                pem = f"-----BEGIN {key_type}-----\n{wrapped}\n-----END {key_type}-----\n"
        try:
            self.private_key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
            log.info("Private key loaded successfully")
        except Exception as e:
            log.error(f"Key load failed: {e}")
            raise

    def sign(self, method: str, path: str) -> dict:
        """Generate signed headers - exactly per Kalshi API docs."""
        ts_ms = str(int(time.time() * 1000))
        path_clean = path.split("?")[0]
        msg_string = ts_ms + method.upper() + path_clean
        log.info(f"Signing: ts={ts_ms} method={method.upper()} path={path_clean}")
        signature = self.private_key.sign(
            msg_string.encode("utf-8"),
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.MAX_LENGTH
            ),
            hashes.SHA256()
        )
        sig_b64 = base64.b64encode(signature).decode("utf-8")
        log.info(f"Signature (first 20): {sig_b64[:20]}...")
        return {
            "KALSHI-ACCESS-KEY":       self.key_id,
            "KALSHI-ACCESS-TIMESTAMP": ts_ms,
            "KALSHI-ACCESS-SIGNATURE": sig_b64,
            "Content-Type":            "application/json",
        }

def _dollars_to_cents(val) -> int:
    """Convert a dollar-amount string like '0.2600' to cents (26)."""
    try:
        return int(round(float(val) * 100))
    except (ValueError, TypeError):
        return 0

# ─── KALSHI CLIENT ─────────────────────────────────────────────
class KalshiClient:
    def __init__(self, auth: KalshiAuth):
        self.auth    = auth
        self.session = requests.Session()
        self.session.timeout = 10

    def _get(self, path: str, params: dict = None) -> Optional[dict]:
        url      = BASE_URL + path
        sign_path = "/trade-api/v2" + path
        headers  = self.auth.sign("GET", sign_path)
        try:
            r = self.session.get(url, headers=headers, params=params)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.error(f"GET {path} failed: {e}")
            return None

    def _post(self, path: str, body: dict) -> Optional[dict]:
        url      = BASE_URL + path
        sign_path = "/trade-api/v2" + path
        headers  = self.auth.sign("POST", sign_path)
        try:
            log.info(f"POST {path} body={json.dumps(body)}")
            r = self.session.post(url, headers=headers, json=body)
            if not r.ok:
                log.error(f"POST {path} -> {r.status_code} {r.text[:300]}")
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log.error(f"POST {path} failed: {e}")
            return None

    def get_balance(self) -> float:
        """Returns cash balance in dollars."""
        data = self._get("/portfolio/balance")
        if data and "balance" in data:
            return data["balance"] / 100.0  # Kalshi returns cents
        return 0.0

    def get_total_value(self) -> tuple:
        """Returns (cash, portfolio_value, total) in dollars."""
        data = self._get("/portfolio/balance")
        if data:
            cash = data.get("balance", 0) / 100.0
            port = data.get("portfolio_value", 0) / 100.0
            return cash, port, cash + port
        return 0.0, 0.0, 0.0

    def get_markets(self, limit=1000, series_ticker=None, event_ticker=None) -> list:
        """
        Get active markets from the Kalshi elections API.
        Returns markets with normalized fields (prices in cents, volume as int).
        Filters out MVE parlay markets and markets with no activity.
        """
        params = {"limit": limit}
        if series_ticker:
            params["series_ticker"] = series_ticker
        if event_ticker:
            params["event_ticker"] = event_ticker

        all_markets = []
        cursor = None
        pages = 0
        max_pages = 5  # up to 5000 markets

        while pages < max_pages:
            if cursor:
                params["cursor"] = cursor
            data = self._get("/markets", params=params)
            if not data:
                break
            markets = data.get("markets", [])
            if not markets:
                break

            for m in markets:
                # Skip MVE parlay markets — they have no real orderbooks
                ticker = m.get("ticker", "")
                if "KXMVE" in ticker:
                    continue

                # Convert new dollar-string fields to cents (int) for internal use
                normalized = dict(m)  # keep all original fields
                normalized["yes_ask"] = _dollars_to_cents(m.get("yes_ask_dollars", "0"))
                normalized["no_ask"]  = _dollars_to_cents(m.get("no_ask_dollars", "0"))
                normalized["yes_bid"] = _dollars_to_cents(m.get("yes_bid_dollars", "0"))
                normalized["no_bid"]  = _dollars_to_cents(m.get("no_bid_dollars", "0"))
                normalized["last_price"] = _dollars_to_cents(m.get("last_price_dollars", "0"))
                normalized["volume"]  = int(float(m.get("volume_fp", "0")))
                normalized["open_interest"] = int(float(m.get("open_interest_fp", "0")))
                normalized["volume_24h"] = float(m.get("volume_24h_fp", "0"))

                # Only include markets with some sign of activity
                if (normalized["volume"] > 0 or
                    normalized["open_interest"] > 0 or
                    0 < normalized["yes_ask"] < 100 or
                    0 < normalized["last_price"] < 100):
                    all_markets.append(normalized)

            cursor = data.get("cursor")
            if not cursor:
                break
            pages += 1

        log.info(f"Fetched {len(all_markets)} active non-parlay markets")
        return all_markets

    def get_markets_by_events(self, limit=100) -> list:
        """
        Get active markets via the /events endpoint (better for finding
        real markets with activity vs the /markets firehose).
        """
        all_markets = []
        cursor = None
        pages = 0

        while pages < 3:
            params = {"limit": limit, "with_nested_markets": "true"}
            if cursor:
                params["cursor"] = cursor
            data = self._get("/events", params=params)
            if not data:
                break
            events = data.get("events", [])
            if not events:
                break

            for e in events:
                for m in (e.get("markets") or []):
                    if not isinstance(m, dict):
                        continue
                    ticker = m.get("ticker", "")
                    if "KXMVE" in ticker:
                        continue

                    normalized = dict(m)
                    normalized["yes_ask"] = _dollars_to_cents(m.get("yes_ask_dollars", "0"))
                    normalized["no_ask"]  = _dollars_to_cents(m.get("no_ask_dollars", "0"))
                    normalized["yes_bid"] = _dollars_to_cents(m.get("yes_bid_dollars", "0"))
                    normalized["no_bid"]  = _dollars_to_cents(m.get("no_bid_dollars", "0"))
                    normalized["last_price"] = _dollars_to_cents(m.get("last_price_dollars", "0"))
                    normalized["volume"]  = int(float(m.get("volume_fp", "0")))
                    normalized["open_interest"] = int(float(m.get("open_interest_fp", "0")))
                    normalized["volume_24h"] = float(m.get("volume_24h_fp", "0"))

                    if (normalized["volume"] > 0 or
                        0 < normalized["yes_ask"] < 100 or
                        0 < normalized["last_price"] < 100):
                        all_markets.append(normalized)

            cursor = data.get("cursor")
            if not cursor:
                break
            pages += 1

        log.info(f"Fetched {len(all_markets)} active markets via events")
        return all_markets

    def get_orderbook(self, ticker: str) -> Optional[dict]:
        """Get orderbook for a market. Normalizes new orderbook_fp format."""
        data = self._get(f"/markets/{ticker}/orderbook")
        if not data:
            return None
        # New API returns orderbook_fp with dollar amounts as strings
        ob_fp = data.get("orderbook_fp", {})
        if ob_fp:
            yes_entries = ob_fp.get("yes_dollars", [])
            no_entries = ob_fp.get("no_dollars", [])
            return {
                "yes": [{"price": int(float(e[0]) * 100), "quantity": int(float(e[1]))}
                        for e in yes_entries if len(e) >= 2],
                "no":  [{"price": int(float(e[0]) * 100), "quantity": int(float(e[1]))}
                        for e in no_entries if len(e) >= 2],
            }
        return data

    def get_positions(self) -> list:
        """Get current open positions."""
        data = self._get("/portfolio/positions")
        return data.get("market_positions", []) if data else []

    def place_order(self, ticker: str, side: str, count: int,
                    price_cents: int, order_type: str = "limit") -> Optional[dict]:
        """
        Place an order on Kalshi.
        side: "yes" or "no"
        count: number of contracts
        price_cents: price in cents (e.g. 47 = $0.47)
        order_type: "limit" or "market"
        """
        if DRY_RUN:
            log.info(f"[DRY RUN] Would place: {side.upper()} {count}x {ticker} @ {price_cents}¢")
            return {"status": "dry_run", "ticker": ticker, "side": side,
                    "count": count, "price": price_cents}

        body = {
            "ticker":    ticker,
            "action":    "buy",
            "side":      side,
            "count":     count,
            "type":      order_type,
        }
        if order_type == "limit":
            body["yes_price" if side == "yes" else "no_price"] = price_cents
            body["time_in_force"] = "immediate_or_cancel"

        result = self._post("/portfolio/orders", body)
        if result:
            log.info(f"Order placed: {side.upper()} {count}x {ticker} @ {price_cents}¢")
        return result

    def cancel_order(self, order_id: str) -> Optional[dict]:
        return self._post(f"/portfolio/orders/{order_id}/cancel", {})

# ─── MATH ──────────────────────────────────────────────────────
def kelly_size(edge_pct: float, win_prob: float, bankroll: float) -> float:
    """
    Kelly Criterion: f* = (p*b - q) / b * KELLY_FRACTION
    edge_pct: e.g. 0.03 for 3% edge
    Returns dollar position size.
    """
    if edge_pct <= 0 or win_prob <= 0:
        return 0.0
    b  = max(0.01, edge_pct / (1 - edge_pct + 0.001))
    q  = 1 - win_prob
    fk = max(0, (win_prob * b - q) / b) * KELLY_FRACTION
    return min(fk * bankroll, MAX_POS_PCT * bankroll)

def contracts_for_dollars(dollars: float, price_cents: int) -> int:
    """How many contracts can we buy for given dollar amount at given price."""
    if price_cents <= 0:
        return 0
    return max(0, math.floor(dollars / (price_cents / 100.0)))

# ─── POLYMARKET ORACLE ─────────────────────────────────────────
def get_polymarket_price(condition_id: str) -> Optional[float]:
    """
    Fetch YES price from Polymarket CLOB using a conditionId.
    The CLOB API requires conditionId (0x-prefixed hex), NOT slugs.
    Returns price as decimal (0.0 - 1.0) or None.
    """
    try:
        r = requests.get(
            f"https://clob.polymarket.com/markets/{condition_id}",
            timeout=5
        )
        if r.status_code == 200:
            data = r.json()
            # CLOB returns tokens array: [{outcome: "Yes", price: 0.55}, ...]
            tokens = data.get("tokens", [])
            for t in tokens:
                if t.get("outcome") == "Yes":
                    return float(t["price"])
            # Fallback to top-level fields
            price = data.get("last_trade_price") or data.get("best_ask")
            return float(price) if price else None
    except Exception:
        pass
    return None


def get_polymarket_price_by_slug(slug: str) -> Optional[float]:
    """
    Search Polymarket Gamma API by slug, then fetch price from CLOB.
    Gamma API search is unreliable, so this uses exact slug lookup.
    Returns YES price as decimal (0.0 - 1.0) or None.
    """
    try:
        r = requests.get(
            "https://gamma-api.polymarket.com/markets",
            params={"slug": slug, "limit": 1},
            timeout=5
        )
        if r.status_code == 200:
            markets = r.json()
            if isinstance(markets, list) and markets:
                m = markets[0]
                # Try outcomePrices directly from Gamma
                prices = m.get("outcomePrices")
                if prices:
                    if isinstance(prices, str):
                        prices = json.loads(prices)
                    if isinstance(prices, list) and len(prices) >= 1:
                        return float(prices[0])
                # Fallback: use conditionId with CLOB
                cid = m.get("conditionId", "")
                if cid:
                    return get_polymarket_price(cid)
    except Exception:
        pass
    return None

# ─── STATE ─────────────────────────────────────────────────────
open_positions = {}   # trade_id -> position dict
held_events    = set()  # event tickers we already hold positions in
held_tickers   = set()  # individual market tickers we hold
session_pnl    = 0.0  # running session P&L in dollars
trade_count    = 0
starting_balance = 0.0  # set on startup, used for kill switch
MAX_DAILY_LOSS = 50.0   # auto-flip to dry run if session P&L < -$50
KILL_SWITCH_PCT = 0.15  # halt trading if balance drops 15% from start
trading_halted = False  # set True by kill switch

# ─── COMPOUNDING: AUTO-ADJUST POSITION SIZE ───────────────────
def update_position_sizing():
    """
    After 20+ closed trades, adjust MAX_POS_PCT based on performance:
    - Win rate > 60% AND profit factor > 1.3 → increase to 15%
    - Win rate < 50% → reduce to 5%
    - Otherwise keep at 10% (default)
    """
    global MAX_POS_PCT
    try:
        conn = sqlite3.connect("apexpm.db")
        c = conn.cursor()
        c.execute("SELECT profit_cents FROM trades WHERE status != 'open'")
        rows = c.fetchall()
        conn.close()

        if len(rows) < 20:
            return  # not enough data

        profits = [r[0] or 0 for r in rows]
        wins = [p for p in profits if p > 0]
        losses = [p for p in profits if p < 0]
        win_rate = len(wins) / len(profits) if profits else 0
        gross_wins = sum(wins) if wins else 0
        gross_losses = abs(sum(losses)) if losses else 1
        profit_factor = gross_wins / gross_losses if gross_losses > 0 else 0

        old_pct = MAX_POS_PCT
        if win_rate > 0.60 and profit_factor > 1.3:
            MAX_POS_PCT = 0.15
        elif win_rate < 0.50:
            MAX_POS_PCT = 0.05
        else:
            MAX_POS_PCT = 0.10

        if MAX_POS_PCT != old_pct:
            log.info(f"[COMPOUNDING] Adjusted MAX_POS_PCT: {old_pct*100:.0f}% -> {MAX_POS_PCT*100:.0f}% "
                     f"(WR={win_rate*100:.0f}% PF={profit_factor:.2f} trades={len(profits)})")
    except Exception as e:
        log.debug(f"Compounding check error: {e}")


# ─── CONVERGENCE EXIT ─────────────────────────────────────────
def check_and_exit_positions(client):
    """
    Fast exit checker — runs every scan cycle in <500ms.
    Zero math. Pre-computed thresholds in _exit_targets.
    1) Batch-fetch prices for all held events in ONE API call each.
    2) Compare current_bid against stored integers.
    3) Fire sell order FIRST (immediate_or_cancel), log AFTER.
    """
    if not _exit_targets:
        return

    t0 = time.time()
    now = int(t0)

    # Group targets by event_ticker for batch fetching
    events = {}
    for ticker, tgt in _exit_targets.items():
        evt = tgt.get("event_ticker", "")
        if evt:
            events.setdefault(evt, []).append(tgt)

    # Batch fetch: one API call per event
    price_map = {}  # ticker -> {yes_bid, no_bid, vol24h}
    for evt, legs in events.items():
        data = client._get("/markets", params={"event_ticker": evt, "limit": 50})
        if not data:
            continue
        for m in data.get("markets", []):
            t = m.get("ticker", "")
            price_map[t] = {
                "yes_bid": _dollars_to_cents(m.get("yes_bid_dollars", "0")),
                "no_bid":  _dollars_to_cents(m.get("no_bid_dollars", "0")),
                "vol24h":  float(m.get("volume_24h_fp", "0")),
            }

    # Compare and fire — order first, log after
    exited = []
    for ticker, tgt in list(_exit_targets.items()):
        prices = price_map.get(ticker)
        if not prices:
            continue

        side        = tgt["side"]
        bid         = prices["yes_bid"] if side == "yes" else prices["no_bid"]
        entry_price = tgt["entry_price"]
        contracts   = tgt["contracts"]
        target      = tgt["target_exit"]
        momentum    = tgt["momentum_exit"]
        stop        = tgt["stop_loss"]
        max_ts      = tgt["max_hold_ts"]
        entry_vol   = tgt.get("entry_vol", 0)
        cur_vol     = prices["vol24h"]

        if bid <= 0:
            continue

        # Pure integer comparisons — no math
        entry_ts    = tgt.get("entry_ts", 0)
        exit_reason = None
        if now >= max_ts:
            exit_reason = "time_exit"
        elif bid <= stop and (now - entry_ts) >= STOP_LOSS_COOLDOWN:
            # 1hr cooldown: don't stop-loss on entry spread noise
            exit_reason = "stop_loss"
        elif entry_vol > 0 and cur_vol >= entry_vol * 2 and bid >= momentum:
            exit_reason = "momentum_exit"
        elif bid >= target:
            exit_reason = "convergence_exit"

        if not exit_reason:
            continue

        # FIRE ORDER FIRST — then log
        if not DRY_RUN:
            result = client.place_order(ticker, side, contracts, bid)
            if not result:
                continue  # failed, retry next scan
        else:
            log.info(f"[EXIT] [DRY RUN] {ticker} {exit_reason} bid={bid}c")

        # Log after order
        entry_ts = tgt.get("entry_ts", now)
        hold_hours = round((now - entry_ts) / 3600.0, 2)
        profit_cents = (bid - entry_price) * contracts
        profit_usd = round(profit_cents / 100.0, 4)
        hit_plan = 1 if exit_reason in ("convergence_exit", "momentum_exit") else 0

        exited.append({
            "trade_id": tgt["trade_id"], "ticker": ticker, "side": side,
            "contracts": contracts, "entry_price": entry_price,
            "exit_price": bid, "hold_hours": hold_hours,
            "profit_cents": profit_cents, "profit_usd": profit_usd,
            "exit_reason": exit_reason, "target": target,
            "stop": stop, "hit_plan": hit_plan,
        })

        log.info(f"[EXIT] {ticker} {exit_reason}: entry={entry_price}c exit={bid}c "
                 f"hold={hold_hours:.1f}h P&L=${profit_usd:.2f}")

        # Remove from in-memory targets
        del _exit_targets[ticker]

    # Batch write all exits to DB after orders are placed
    if exited:
        try:
            conn = sqlite3.connect("apexpm.db")
            c = conn.cursor()
            for e in exited:
                c.execute("""
                    INSERT INTO trade_exits
                    (trade_id, exit_ts, ticker, side, contracts,
                     entry_price_cents, exit_price_cents, hold_time_hours,
                     profit_cents, profit_usd, exit_reason,
                     plan_target_cents, plan_stop_cents, hit_plan)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (e["trade_id"], now, e["ticker"], e["side"],
                      e["contracts"], e["entry_price"], e["exit_price"],
                      e["hold_hours"], e["profit_cents"], e["profit_usd"],
                      e["exit_reason"], e["target"], e["stop"], e["hit_plan"]))
            conn.commit()
            conn.close()
        except Exception:
            pass

    elapsed_ms = int((time.time() - t0) * 1000)
    if _exit_targets or exited:
        log.info(f"[EXIT CHECK] {elapsed_ms}ms | {len(exited)} exits | "
                 f"{len(_exit_targets)} remaining targets")


# ─── STRATEGY: YES/NO ARB ──────────────────────────────────────
def scan_yes_no_arb(client: KalshiClient, bankroll: float) -> list:
    """
    Find markets where YES bid + NO bid < 98 cents (BID-based edge).

    Using BID prices means we're looking at what we can actually SELL for,
    not what we'd have to pay. If yes_bid + no_bid < 98, there's at least
    2c of edge. We BUY at the ASK, but the edge is measured by the BIDs
    because that's our exit price.
    """
    opportunities = []
    # Events endpoint is the reliable source for active markets
    markets = client.get_markets_by_events()

    # Debug: track filter stages
    total = len(markets)
    skip_no_bid = 0
    skip_low_volume = 0
    skip_no_edge = 0
    skip_no_contracts = 0
    # Track all markets with both bids for near-arb report
    scored_markets = []

    for m in markets:
        try:
            ticker     = m.get("ticker", "")
            yes_ask    = m.get("yes_ask", 0)   # cents (already normalized)
            no_ask     = m.get("no_ask", 0)
            yes_bid    = m.get("yes_bid", 0)
            no_bid     = m.get("no_bid", 0)
            volume_24h = m.get("volume_24h", 0)

            if not yes_bid or not no_bid:
                skip_no_bid += 1
                continue

            # Edge based on BID prices — what we can sell for
            combined_bid = yes_bid + no_bid
            # Cost to enter = yes_ask + no_ask (what we pay)
            combined_ask = yes_ask + no_ask if yes_ask and no_ask else 999
            # True edge = 100 (settlement) - cost to enter
            # But use bid-based signal: if bids are far below 100, there's room
            edge_cents = 100 - combined_ask  # profit at settlement
            bid_signal = 98 - combined_bid   # bid-based trigger (positive = bids below 98)

            scored_markets.append({
                "ticker": ticker, "yes_ask": yes_ask, "no_ask": no_ask,
                "yes_bid": yes_bid, "no_bid": no_bid,
                "combined_ask": combined_ask, "combined_bid": combined_bid,
                "edge": edge_cents, "bid_signal": bid_signal,
                "vol24h": volume_24h, "title": m.get("title", "")[:50],
            })

            if volume_24h < MIN_VOLUME_24H:
                skip_low_volume += 1
                if edge_cents >= MIN_EDGE_CENTS:
                    log_missed(ticker, "", "yes_no_arb", edge_cents,
                               "low_volume", f"vol24h={volume_24h:.0f} ask={combined_ask}c bid={combined_bid}c")
                continue

            # Require bid signal: combined bids must be < 98c
            if bid_signal < 0:
                skip_no_edge += 1
                continue

            # Also require positive settlement edge
            if edge_cents < MIN_EDGE_CENTS:
                skip_no_edge += 1
                continue

            edge_pct  = edge_cents / 100.0
            win_prob  = 0.97  # YES/NO arb is near-guaranteed at settlement
            size      = kelly_size(edge_pct, win_prob, bankroll)

            # Hard caps while balance < $450
            if bankroll < SAFE_BALANCE:
                size = min(size, MAX_TRADE_USD)

            contracts = min(
                contracts_for_dollars(size, yes_ask),
                contracts_for_dollars(size, no_ask)
            )

            # Hard cap contracts
            if bankroll < SAFE_BALANCE:
                contracts = min(contracts, MAX_CONTRACTS)

            if contracts < 1:
                skip_no_contracts += 1
                log_missed(ticker, "", "yes_no_arb", edge_cents,
                           "position_too_small", f"size=${size:.2f} edge={edge_cents:.1f}c")
                continue

            opportunities.append({
                "strategy":   "yes_no_arb",
                "ticker":     ticker,
                "market":     m.get("title", ticker),
                "yes_ask":    yes_ask,
                "no_ask":     no_ask,
                "edge_cents": edge_cents,
                "edge_pct":   edge_pct,
                "win_prob":   win_prob,
                "size_usd":   size,
                "contracts":  contracts,
                "volume_24h": volume_24h,
            })
        except Exception as e:
            log.debug(f"Market scan error {m.get('ticker')}: {e}")

    # ── Debug: filter funnel & near-arb report ──
    log.info(f"[ARB SCAN] Filter funnel: {total} total -> "
             f"{skip_no_bid} no bid -> {len(scored_markets)} with both bids -> "
             f"{skip_low_volume} low vol24h -> {skip_no_edge} no edge -> "
             f"{skip_no_contracts} no contracts -> {len(opportunities)} opportunities")

    if scored_markets:
        scored_markets.sort(key=lambda x: x["combined_bid"])
        log.info("[ARB SCAN] Top 5 closest to arb (lowest YES bid + NO bid):")
        for s in scored_markets[:5]:
            log.info(f"  {s['ticker'][:40]:40s} bid={s['yes_bid']:2d}+{s['no_bid']:2d}={s['combined_bid']:3d}c "
                     f"ask={s['combined_ask']:3d}c  edge={s['edge']:+d}c  "
                     f"vol24h={s['vol24h']:.0f}  {s['title']}")

    # Log market scans to DB (top 50 by edge to avoid bloat)
    scan_ts = int(time.time())
    scored_markets.sort(key=lambda x: x["edge"], reverse=True)
    log_market_scans(scan_ts, scored_markets[:50], "yes_no_arb")

    # Sort by edge descending
    return sorted(opportunities, key=lambda x: x["edge_cents"], reverse=True)

# ─── STRATEGY: CROSS-PLATFORM ──────────────────────────────────
# Ticker mapping: Kalshi series -> Polymarket lookup
# poly_type: "slug" uses Gamma API exact slug, "condition_id" uses CLOB directly
# NOTE: Polymarket slugs change frequently. If a pair returns None,
# check https://polymarket.com and update the slug here.
CROSS_PLATFORM_PAIRS = [
    # Find current slugs at https://polymarket.com — search and copy from URL
    # Example: polymarket.com/event/fed-meeting-june-2026 -> slug from the market URL
    # These are placeholders — update with real slugs when you find matching markets
]

def scan_cross_platform(client: KalshiClient, bankroll: float) -> list:
    """
    Use Polymarket as a free price oracle.
    If Polymarket YES price significantly differs from Kalshi YES ask,
    buy the cheaper side on Kalshi.
    """
    opportunities = []

    if not CROSS_PLATFORM_PAIRS:
        log.info("[CROSS-PLATFORM] No pairs configured — add Polymarket slugs to CROSS_PLATFORM_PAIRS")
        return opportunities

    log.info(f"[CROSS-PLATFORM] Scanning {len(CROSS_PLATFORM_PAIRS)} pairs...")

    for pair in CROSS_PLATFORM_PAIRS:
        kalshi_ticker = pair["kalshi"]
        poly_id = pair.get("poly_slug") or pair.get("poly_condition_id", "")
        try:
            # Try slug first, fall back to condition_id
            if pair.get("poly_slug"):
                poly_yes = get_polymarket_price_by_slug(pair["poly_slug"])
            else:
                poly_yes = get_polymarket_price(pair["poly_condition_id"])

            if poly_yes is None:
                log.info(f"[CROSS-PLATFORM] {kalshi_ticker}: Polymarket '{poly_id[:40]}' returned no price")
                log_missed(kalshi_ticker, "", "cross_platform", 0,
                           "poly_no_price", poly_id[:60])
                continue

            # Get Kalshi market — find by ticker prefix (use series filter)
            markets = client.get_markets(series_ticker=kalshi_ticker)
            if not markets:
                markets = client.get_markets_by_events()
            kalshi_market = next(
                (m for m in markets if m.get("ticker", "").startswith(kalshi_ticker)),
                None
            )
            if not kalshi_market:
                log.info(f"[CROSS-PLATFORM] {kalshi_ticker}: No matching Kalshi market found")
                log_missed(kalshi_ticker, "", "cross_platform", 0,
                           "no_kalshi_match", f"poly={poly_yes:.4f}")
                continue

            kalshi_yes_ask = kalshi_market.get("yes_ask", 0)  # already in cents
            kalshi_no_ask  = kalshi_market.get("no_ask", 0)
            volume_24h     = kalshi_market.get("volume_24h", 0)

            if not kalshi_yes_ask:
                log.info(f"[CROSS-PLATFORM] {kalshi_ticker}: Kalshi yes_ask=0 (no ask price)")
                log_missed(kalshi_ticker, "", "cross_platform", 0,
                           "kalshi_no_ask", f"poly={poly_yes:.4f}")
                continue
            if volume_24h < MIN_VOLUME_24H:
                log.info(f"[CROSS-PLATFORM] {kalshi_ticker}: vol24h={volume_24h:.0f} < {MIN_VOLUME_24H} (low volume)")
                log_missed(kalshi_ticker, "", "cross_platform", 0,
                           "low_volume", f"vol24h={volume_24h:.0f} poly={poly_yes:.4f}")
                continue

            kalshi_yes_pct = kalshi_yes_ask / 100.0
            edge = abs(poly_yes - kalshi_yes_pct)

            log.info(f"[CROSS-PLATFORM] {kalshi_ticker}: Poly={poly_yes:.4f} Kalshi={kalshi_yes_pct:.4f} "
                     f"Edge={edge*100:.1f}c (need>{MIN_EDGE_CENTS}c) vol24h={volume_24h:.0f}")

            if edge < (MIN_EDGE_CENTS / 100.0):
                continue

            # Trade the cheap side on Kalshi
            if poly_yes > kalshi_yes_pct:
                side       = "yes"
                price      = kalshi_yes_ask
                win_prob   = min(0.90, poly_yes)
            else:
                side       = "no"
                price      = kalshi_no_ask
                win_prob   = min(0.90, 1 - poly_yes)

            size      = kelly_size(edge, win_prob, bankroll)
            contracts = contracts_for_dollars(size, price)

            if contracts < 1:
                log.info(f"[CROSS-PLATFORM] {kalshi_ticker}: Edge found but position too small (size=${size:.2f})")
                continue

            opportunities.append({
                "strategy":    "cross_platform",
                "ticker":      kalshi_market.get("ticker"),
                "market":      kalshi_market.get("title", kalshi_ticker),
                "side":        side,
                "price":       price,
                "poly_yes":    poly_yes,
                "kalshi_yes":  kalshi_yes_pct,
                "edge_pct":    edge,
                "win_prob":    win_prob,
                "size_usd":    size,
                "contracts":   contracts,
                "volume_24h":  volume_24h,
            })

        except Exception as e:
            log.warning(f"[CROSS-PLATFORM] {kalshi_ticker}: Error: {e}")

    log.info(f"[CROSS-PLATFORM] Result: {len(opportunities)} opportunities from {len(CROSS_PLATFORM_PAIRS)} pairs")
    return sorted(opportunities, key=lambda x: x["edge_pct"], reverse=True)

# ─── STRATEGY: MULTI-LEG EVENT ARB ────────────────────────────
# Patterns that indicate cumulative/threshold markets (NOT mutually exclusive)
import re
_CUMULATIVE_PATTERNS = re.compile(
    r'(above|below|more than|less than|at least|over|under|higher than|lower than|before \d|by \w+ \d)',
    re.IGNORECASE
)

# Events where MULTIPLE outcomes can be true (not mutually exclusive)
_MULTI_TRUE_PATTERNS = re.compile(
    r'(pardon|bridesmaid|groomsman|groomsmen|what songs|which agencies|'
    r'what will .* withdraw|what will .* eliminate|attend|'
    r'which countries will|what countries will|who will .* invite|'
    r'which .* will resign|which .* will leave)',
    re.IGNORECASE
)

def _is_likely_exclusive(event_title: str, market_titles: list) -> bool:
    """
    Heuristic: detect whether an event's markets are mutually exclusive
    (exactly one outcome wins). Conservative — returns False if unsure.

    EXCLUSIVE: "Who will be the next X" (pope, president, PM, CEO, Bond) —
    exactly one person/outcome wins.

    NOT EXCLUSIVE:
    - Threshold/cumulative: "above X", "more than Y"
    - Multi-true: "Who will Trump pardon" (multiple pardons possible),
      "What songs on GTA 6" (multiple songs), bridesmaids, agencies, etc.
    """
    title_lower = event_title.lower()

    # Reject multi-true events (multiple outcomes can be YES)
    if _MULTI_TRUE_PATTERNS.search(title_lower):
        return False

    # Reject cumulative/threshold markets
    cumulative_count = sum(
        1 for t in market_titles if _CUMULATIVE_PATTERNS.search(t)
    )
    if cumulative_count > len(market_titles) * 0.5:
        return False

    # Strong exclusive signals: "next X" (only one next pope, PM, etc.)
    exclusive_keywords = [
        "who will be the next", "who will replace",
        "next pope", "next president", "next pm", "next prime minister",
        "next speaker", "next ceo", "next bond", "next leader",
        "person of the decade", "person of the year",
        "first trillionaire", "51st state",
        "presidential election winner", "election winner",
        "who will play ", "who will perform ",
    ]
    if any(kw in title_lower for kw in exclusive_keywords):
        return True

    # "Where will X" with location options = exclusive (one wedding location)
    if "where will" in title_lower:
        return True

    # "What will X be" (genre, price range as named buckets) — cautious
    # Only if it's clearly a single-choice question
    if "what will" in title_lower and "what will" not in title_lower.replace("what will the price", ""):
        # "What will the price be" is sometimes cumulative — skip
        pass

    return False


def check_exit_liquidity(markets: list, side: str) -> tuple:
    """
    Pre-trade validation: verify every leg has enough liquidity to exit.

    Checks for the given side ("yes" or "no"):
    - The opposite bid must be > 0 (someone will buy us out)
    - vol24h >= MIN_LEG_VOL24H on every leg
    - Spread (ask - bid) <= MAX_LEG_SPREAD on every leg

    Returns (ok: bool, reason: str). If ok is False, reason explains
    which leg failed and why.
    """
    for m in markets:
        ticker = m["ticker"]

        # Check 0: market must be active/tradeable
        mstatus = m.get("status", "")
        if mstatus and mstatus not in ("active", "open"):
            return False, f"{ticker}: status={mstatus} (not tradeable)"

        if side == "yes":
            bid = m["yes_bid"]
            ask = m["yes_ask"]
        else:
            bid = m["no_bid"]
            ask = m["no_ask"]

        # Check 1: bid must exist (someone to sell to)
        if bid <= 0:
            return False, f"{ticker}: {side}_bid=0 (no exit buyer)"

        # Check 2: minimum 24h volume
        vol24 = m.get("vol24h", 0)
        if vol24 < MIN_LEG_VOL24H:
            return False, f"{ticker}: vol24h={vol24:.0f} < {MIN_LEG_VOL24H} (too thin)"

        # Check 3: spread not too wide
        spread = ask - bid
        if ask > 0 and spread > MAX_LEG_SPREAD:
            return False, f"{ticker}: spread={spread}c (bid={bid} ask={ask}) > {MAX_LEG_SPREAD}c max"

    return True, "all legs pass"


def _days_to_expiration(markets: list) -> float:
    """Return days until the earliest market expiration. Defaults to 365 if unknown."""
    now = datetime.datetime.utcnow()
    earliest = None
    for m in markets:
        exp_str = m.get("expiration", "")
        if not exp_str:
            continue
        try:
            exp = datetime.datetime.fromisoformat(exp_str.replace("Z", "+00:00")).replace(tzinfo=None)
            if earliest is None or exp < earliest:
                earliest = exp
        except (ValueError, TypeError):
            continue
    if earliest is None:
        return 365.0
    delta = (earliest - now).total_seconds() / 86400.0
    return max(delta, 0.1)  # at least 0.1 to avoid div by zero


def scan_event_arb(client: KalshiClient, bankroll: float) -> list:
    """
    Multi-leg event arbitrage: find events with mutually exclusive outcomes
    where the sum of prices is mispriced.

    For exclusive events (exactly one outcome is YES):
    - BUY ALL YES: if sum(yes_ask) < 100c, buying YES on every outcome
      guarantees profit since exactly one pays 100c.
    - BUY ALL NO: if sum(no_ask) < (N-1)*100c, buying NO on every outcome
      guarantees profit since exactly N-1 pay 100c.
      Equivalently: sum(yes_bid) > 100c means the NO side is cheap.
    """
    opportunities = []

    # Fetch events with nested markets
    cursor = None
    events_scanned = 0
    exclusive_events = 0
    skip_illiquid = 0

    for page in range(5):
        params = {"limit": 50, "with_nested_markets": "true"}
        if cursor:
            params["cursor"] = cursor
        data = client._get("/events", params=params)
        if not data:
            break
        events = data.get("events", [])
        if not events:
            break
        cursor = data.get("cursor")

        for e in events:
            evt_markets_raw = e.get("markets", [])
            if not isinstance(evt_markets_raw, list) or len(evt_markets_raw) < 2:
                continue

            events_scanned += 1
            event_ticker = e.get("event_ticker", "")
            event_title = e.get("title", "")

            # Skip blacklisted events
            if event_ticker in EVENT_BLACKLIST:
                log_missed("", event_ticker, "event_arb", 0, "blacklisted", event_title)
                continue

            # Normalize markets — only include active (tradeable) ones
            markets = []
            for m in evt_markets_raw:
                if not isinstance(m, dict):
                    continue
                ticker = m.get("ticker", "")
                if "KXMVE" in ticker:
                    continue
                # Skip settled/finalized/closed markets
                mstatus = m.get("status", "")
                if mstatus not in ("active", "open", ""):
                    continue
                ya = _dollars_to_cents(m.get("yes_ask_dollars", "0"))
                yb = _dollars_to_cents(m.get("yes_bid_dollars", "0"))
                na = _dollars_to_cents(m.get("no_ask_dollars", "0"))
                nb = _dollars_to_cents(m.get("no_bid_dollars", "0"))
                vol24 = float(m.get("volume_24h_fp", "0"))
                vol = int(float(m.get("volume_fp", "0")))
                if ya <= 0 and yb <= 0:
                    continue  # no price data at all
                markets.append({
                    "ticker": ticker,
                    "title": m.get("title", ""),
                    "yes_ask": ya, "yes_bid": yb,
                    "no_ask": na, "no_bid": nb,
                    "vol24h": vol24, "volume": vol,
                    "status": mstatus,
                    "expiration": m.get("expiration_time", ""),
                })

            if len(markets) < 2:
                continue

            # Check if event is mutually exclusive
            market_tickers = [m["ticker"] for m in markets]
            if not _is_likely_exclusive(event_title, market_tickers):
                continue

            exclusive_events += 1
            n = len(markets)

            # ── BUY ALL YES arb ──
            # If sum(yes_ask) < 100c, buying YES on every outcome costs
            # less than 100c and one MUST pay 100c = guaranteed profit.
            #
            # RISK: only works if the event GUARANTEES one outcome resolves
            # YES.  "2028 election winner" is guaranteed; "51st state" or
            # "next pope" might resolve with NO winner → total loss.
            # We still surface these but cap size at 5% bankroll and flag
            # non-guaranteed events in the log.
            buyable_yes = [m for m in markets if m["yes_ask"] > 0]
            if len(buyable_yes) == n:
                sum_yes_ask = sum(m["yes_ask"] for m in buyable_yes)
                buy_yes_edge = 100 - sum_yes_ask  # positive = profit

                if buy_yes_edge >= MIN_EVENT_EDGE:
                    # Liquidity gate: can we exit every leg?
                    liq_ok, liq_reason = check_exit_liquidity(buyable_yes, "yes")
                    if not liq_ok:
                        skip_illiquid += 1
                        log_missed("", event_ticker, "event_arb_buy_yes",
                                   buy_yes_edge, f"illiquid: {liq_reason}", event_title)
                        continue

                    cost_per_set = sum_yes_ask / 100.0  # dollars
                    # Capital cap: min of 5% (risky), 20% hard cap
                    cap = min(bankroll * 0.05, bankroll * MAX_EVENT_PCT)
                    max_sets = math.floor(cap / cost_per_set) if cost_per_set > 0 else 0

                    # Time horizon scoring
                    days_to_exp = _days_to_expiration(buyable_yes)
                    edge_per_day = buy_yes_edge / max(days_to_exp, 1)
                    target_exit = min(TARGET_EXIT_DAYS, days_to_exp)

                    expected_profit = buy_yes_edge / 100.0 * max_sets
                    if max_sets >= 1 and expected_profit >= MIN_TRADE_PROFIT:
                        opportunities.append({
                            "strategy":     "event_arb",
                            "arb_type":     "buy_all_yes",
                            "event_ticker": event_ticker,
                            "event_title":  event_title,
                            "n_markets":    n,
                            "markets":      buyable_yes,
                            "sum_cost":     sum_yes_ask,
                            "edge_cents":   buy_yes_edge,
                            "edge_pct":     buy_yes_edge / 100.0,
                            "edge_per_day": edge_per_day,
                            "days_to_exp":  days_to_exp,
                            "target_exit":  target_exit,
                            "contracts":    max_sets,
                            "cost_usd":     cost_per_set * max_sets,
                            "profit_usd":   expected_profit,
                        })
                    elif max_sets >= 1:
                        log_missed("", event_ticker, "event_arb_buy_yes",
                                   buy_yes_edge, "profit_too_low",
                                   f"${expected_profit:.2f} < ${MIN_TRADE_PROFIT}")

            # ── BUY ALL NO arb ──
            # If sum(yes_bid) > 100, then buying NO on all is profitable.
            # Cost of buying NO on all = sum(no_ask) = N*100 - sum(yes_bid)
            # Payout = (N-1)*100 (all but the winner pay out)
            # Edge = (N-1)*100 - sum(no_ask) = sum(yes_bid) - 100
            buyable_no = [m for m in markets if m["no_ask"] > 0]
            if len(buyable_no) == n:
                sum_yes_bid = sum(m["yes_bid"] for m in buyable_no)
                buy_no_edge = sum_yes_bid - 100  # positive = profit

                if buy_no_edge >= MIN_EVENT_EDGE:
                    # Liquidity gate: can we exit every leg?
                    liq_ok, liq_reason = check_exit_liquidity(buyable_no, "no")
                    if not liq_ok:
                        skip_illiquid += 1
                        log_missed("", event_ticker, "event_arb_buy_no",
                                   buy_no_edge, f"illiquid: {liq_reason}", event_title)
                        continue

                    sum_no_ask = sum(m["no_ask"] for m in buyable_no)
                    cost_per_set = sum_no_ask / 100.0  # dollars
                    payout_per_set = (n - 1)  # dollars (N-1 contracts pay $1)
                    profit_per_set = payout_per_set - cost_per_set

                    # Capital cap: 20% of balance per event
                    cap = bankroll * MAX_EVENT_PCT
                    max_sets = math.floor(min(
                        cap / cost_per_set,
                        bankroll * KELLY_FRACTION / cost_per_set
                    )) if cost_per_set > 0 else 0

                    # Time horizon scoring
                    days_to_exp = _days_to_expiration(buyable_no)
                    edge_per_day = buy_no_edge / max(days_to_exp, 1)
                    target_exit = min(TARGET_EXIT_DAYS, days_to_exp)

                    expected_profit = profit_per_set * max_sets
                    if max_sets >= 1 and expected_profit >= MIN_TRADE_PROFIT:
                        opportunities.append({
                            "strategy":     "event_arb",
                            "arb_type":     "buy_all_no",
                            "event_ticker": event_ticker,
                            "event_title":  event_title,
                            "n_markets":    n,
                            "markets":      buyable_no,
                            "sum_cost":     sum_no_ask,
                            "edge_cents":   buy_no_edge,
                            "edge_pct":     buy_no_edge / sum_no_ask if sum_no_ask > 0 else 0,
                            "edge_per_day": edge_per_day,
                            "days_to_exp":  days_to_exp,
                            "target_exit":  target_exit,
                            "contracts":    max_sets,
                            "cost_usd":     cost_per_set * max_sets,
                            "profit_usd":   expected_profit,
                        })
                    elif max_sets >= 1:
                        log_missed("", event_ticker, "event_arb_buy_no",
                                   buy_no_edge, "profit_too_low",
                                   f"${expected_profit:.2f} < ${MIN_TRADE_PROFIT}")

        if not cursor:
            break

    # ── Debug logging ──
    log.info(f"[EVENT ARB] Scanned {events_scanned} multi-market events, "
             f"{exclusive_events} exclusive, {skip_illiquid} rejected illiquid, "
             f"{len(opportunities)} tradeable opportunities")

    # Sort by edge_per_day (short-term high-edge trades first)
    opportunities.sort(key=lambda x: x.get("edge_per_day", 0), reverse=True)

    for opp in opportunities[:5]:
        log.info(f"  [{opp['arb_type'].upper()}] {opp['event_ticker']} — {opp['event_title'][:50]}")
        log.info(f"    {opp['n_markets']} legs | cost={opp['sum_cost']}c | "
                 f"edge={opp['edge_cents']:+d}c ({opp['edge_per_day']:.2f}c/day) | "
                 f"expires={opp['days_to_exp']:.0f}d | exit={opp['target_exit']}d | "
                 f"{opp['contracts']}x sets | profit=${opp['profit_usd']:.2f}")
        for m in opp["markets"][:4]:
            log.info(f"      {m['ticker'][:40]:40s} YES={m['yes_bid']:2d}/{m['yes_ask']:2d}c "
                     f"NO={m['no_bid']:2d}/{m['no_ask']:2d}c vol24h={m['vol24h']:.0f}")
        if len(opp["markets"]) > 4:
            log.info(f"      ... and {len(opp['markets'])-4} more legs")

    # Log all opportunities to DB (taken status set later by executor)
    scan_ts = int(time.time())
    for opp in opportunities:
        log_opportunity(scan_ts, opp, taken=False, rejection_reason="")

    return opportunities


# ─── EXECUTE TRADE ─────────────────────────────────────────────
def execute_event_arb(client: KalshiClient, opp: dict) -> bool:
    """
    Execute a multi-leg event arb by placing orders on all legs.
    For buy_all_yes: buy YES on every market in the event.
    For buy_all_no: buy NO on every market in the event.
    """
    global open_positions, trade_count, held_events, held_tickers

    arb_type = opp["arb_type"]
    event = opp["event_ticker"]
    contracts = opp["contracts"]
    markets = opp["markets"]
    side = "yes" if arb_type == "buy_all_yes" else "no"

    # ── Duplicate guard: skip if we already hold this event ──
    if event in held_events:
        log.info(f"[EVENT ARB] SKIP {event} — already holding position in this event")
        log_missed("", event, "event_arb", opp.get("edge_cents", 0),
                   "duplicate_event", opp.get("event_title", ""))
        log_opportunity(int(time.time()), opp, taken=False, rejection_reason="duplicate_event")
        return False
    # Also check individual tickers
    leg_tickers = {m["ticker"] for m in markets}
    overlap = leg_tickers & held_tickers
    if overlap:
        log.info(f"[EVENT ARB] SKIP {event} — already hold {len(overlap)} leg(s): {list(overlap)[:3]}")
        log_missed("", event, "event_arb", opp.get("edge_cents", 0),
                   "duplicate_tickers", f"{list(overlap)[:3]}")
        log_opportunity(int(time.time()), opp, taken=False, rejection_reason="duplicate_tickers")
        return False

    # ── Pre-trade liquidity check (final gate) ──
    liq_ok, liq_reason = check_exit_liquidity(markets, side)
    if not liq_ok:
        log.info(f"[EVENT ARB] REJECT {event} — exit liquidity check failed: {liq_reason}")
        log_missed("", event, "event_arb", opp.get("edge_cents", 0),
                   f"exec_illiquid: {liq_reason}", opp.get("event_title", ""))
        log_opportunity(int(time.time()), opp, taken=False, rejection_reason=f"exec_illiquid: {liq_reason}")
        return False

    log.info(f"[EVENT ARB] Executing {arb_type} on {event} — "
             f"{len(markets)} legs x {contracts} contracts | "
             f"edge={opp['edge_cents']:+d}c | cost=${opp['cost_usd']:.2f}")

    filled_legs = []
    failed = False

    for m in markets:
        price = m["yes_ask"] if side == "yes" else m["no_ask"]
        if price <= 0:
            log.warning(f"[EVENT ARB] Skipping {m['ticker']} — {side}_ask=0")
            continue

        result = client.place_order(m["ticker"], side, contracts, price)
        if result:
            filled_legs.append(m["ticker"])
        else:
            log.warning(f"[EVENT ARB] Leg failed: {side.upper()} {contracts}x {m['ticker']} @ {price}c")
            failed = True
            break

    if failed and filled_legs:
        log.warning(f"[EVENT ARB] PARTIAL FILL on {event} — "
                    f"{len(filled_legs)}/{len(markets)} legs filled. "
                    f"Position may be unhedged!")

    if not filled_legs:
        return False

    trade_id = f"EVT_{event}_{int(time.time())}"
    trade_count += 1

    trade = {
        "id":              trade_id,
        "ts":              int(time.time()),
        "market":          opp["event_title"][:100],
        "ticker":          event,
        "strategy":        f"Event Arb ({arb_type})",
        "side":            side,
        "contracts":       contracts * len(filled_legs),
        "entry_yes_cents": opp["sum_cost"] if side == "yes" else None,
        "entry_no_cents":  opp["sum_cost"] if side == "no" else None,
        "exit_yes_cents":  None,
        "exit_no_cents":   None,
        "edge_pct":        opp["edge_pct"],
        "fill_rate":       len(filled_legs) / len(markets),
        "profit_cents":    opp["edge_cents"] * contracts,
        "status":          "open" if not failed else "partial",
        "notes":           f"{arb_type} {len(filled_legs)}/{len(markets)} legs "
                           f"edge={opp['edge_cents']:+d}c"
    }

    # Pre-compute all exit thresholds — zero math at exit time
    create_exit_targets(trade_id, opp, side, markets, contracts)

    log_trade(trade)
    open_positions[trade_id] = trade
    held_events.add(event)
    held_tickers.update(filled_legs)

    log.info(f"  Event arb placed: {event} | {len(filled_legs)}/{len(markets)} legs | "
             f"Expected profit: ${opp['profit_usd']:.2f}")
    log_opportunity(int(time.time()), opp, taken=True)
    return True


def execute_yes_no_arb(client: KalshiClient, opp: dict) -> bool:
    """Execute both legs of a YES/NO arb simultaneously."""
    global open_positions, trade_count

    ticker    = opp["ticker"]
    contracts = opp["contracts"]

    log.info(
        f"[YES/NO ARB] {ticker} | YES {opp['yes_ask']}¢ + NO {opp['no_ask']}¢ = "
        f"{opp['yes_ask']+opp['no_ask']}¢ | Edge: {opp['edge_cents']:.1f}¢ | "
        f"{contracts} contracts"
    )

    # Place YES leg
    yes_result = client.place_order(ticker, "yes", contracts, opp["yes_ask"])
    if not yes_result:
        log.warning(f"YES leg failed for {ticker}")
        return False

    # Place NO leg
    no_result = client.place_order(ticker, "no", contracts, opp["no_ask"])
    if not no_result:
        log.warning(f"NO leg failed for {ticker} — position may be unhedged!")
        # In a real scenario you'd want to cancel the YES order here
        return False

    trade_id = f"{ticker}_{int(time.time())}"
    trade_count += 1

    trade = {
        "id":              trade_id,
        "ts":              int(time.time()),
        "market":          opp["market"],
        "ticker":          ticker,
        "strategy":        "YES/NO Arb",
        "side":            "both",
        "contracts":       contracts,
        "entry_yes_cents": opp["yes_ask"],
        "entry_no_cents":  opp["no_ask"],
        "exit_yes_cents":  None,
        "exit_no_cents":   None,
        "edge_pct":        opp["edge_pct"],
        "fill_rate":       1.0,
        "profit_cents":    opp["edge_cents"] * contracts,  # expected
        "status":          "open",
        "notes":           f"Edge: {opp['edge_cents']:.1f}¢"
    }

    log_trade(trade)
    open_positions[trade_id] = trade

    log.info(f"✓ Arb executed: {ticker} | Expected profit: ${opp['edge_cents']*contracts/100:.2f}")
    return True

def execute_cross_platform(client: KalshiClient, opp: dict) -> bool:
    """Execute a cross-platform trade on Kalshi."""
    global open_positions, trade_count

    ticker    = opp["ticker"]
    side      = opp["side"]
    contracts = opp["contracts"]

    log.info(
        f"[CROSS-PLATFORM] {ticker} | Buy {side.upper()} @ {opp['price']}¢ | "
        f"Poly: {opp['poly_yes']:.3f} vs Kalshi: {opp['kalshi_yes']:.3f} | "
        f"Edge: {opp['edge_pct']*100:.1f}¢"
    )

    result = client.place_order(ticker, side, contracts, opp["price"])
    if not result:
        return False

    trade_id  = f"{ticker}_{side}_{int(time.time())}"
    trade_count += 1

    trade = {
        "id":              trade_id,
        "ts":              int(time.time()),
        "market":          opp["market"],
        "ticker":          ticker,
        "strategy":        "Cross-Platform",
        "side":            side,
        "contracts":       contracts,
        "entry_yes_cents": opp["price"] if side == "yes" else None,
        "entry_no_cents":  opp["price"] if side == "no"  else None,
        "exit_yes_cents":  None,
        "exit_no_cents":   None,
        "edge_pct":        opp["edge_pct"],
        "fill_rate":       1.0,
        "profit_cents":    int(opp["edge_pct"] * 100 * contracts),
        "status":          "open",
        "notes":           f"Poly={opp['poly_yes']:.3f} Kalshi={opp['kalshi_yes']:.3f}"
    }

    log_trade(trade)
    open_positions[trade_id] = trade
    return True

# ─── STRATEGY: MULTI-OUTCOME ARB ──────────────────────────────
def _fetch_events_paginated(client: KalshiClient, max_pages: int = 10,
                             series_ticker: str = None) -> list:
    """
    Fetch events with nested markets, optionally filtered by series_ticker.
    Returns raw event dicts. Deduplicates internally by event_ticker.
    """
    all_events = []
    cursor = None
    seen_tickers = set()

    for page in range(max_pages):
        params = {"limit": 50, "with_nested_markets": "true"}
        if series_ticker:
            params["series_ticker"] = series_ticker
        if cursor:
            params["cursor"] = cursor
        data = client._get("/events", params=params)
        if not data:
            break
        events = data.get("events", [])
        if not events:
            break
        for e in events:
            et = e.get("event_ticker", "")
            if et not in seen_tickers:
                seen_tickers.add(et)
                all_events.append(e)
        cursor = data.get("cursor")
        if not cursor:
            break

    return all_events


def _fetch_all_category_events(client: KalshiClient) -> list:
    """
    Broad sweep + targeted series ticker sweeps to gather 300+ events.
    Deduplicates by event_ticker across all sweeps.
    """
    all_events = []
    seen = set()
    series_new_counts = {}

    # Step 1: broad uncategorized fetch (up to 500 events)
    broad = _fetch_events_paginated(client, max_pages=MULTI_ARB_BROAD_PAGES)
    for e in broad:
        et = e.get("event_ticker", "")
        if et not in seen:
            seen.add(et)
            all_events.append(e)
    broad_count = len(all_events)

    # Step 2: targeted series ticker sweeps for specific categories
    for series in MULTI_ARB_SERIES:
        before = len(all_events)
        for e in _fetch_events_paginated(client, max_pages=MULTI_ARB_SERIES_PAGES,
                                          series_ticker=series):
            et = e.get("event_ticker", "")
            if et not in seen:
                seen.add(et)
                all_events.append(e)
        added = len(all_events) - before
        if added > 0:
            series_new_counts[series] = added

    series_total = len(all_events) - broad_count
    log.info(f"[MULTI-ARB] Fetched {len(all_events)} unique events "
             f"(broad={broad_count}, series={series_total} new from "
             f"{len(MULTI_ARB_SERIES)} tickers)")
    if series_new_counts:
        log.info(f"[MULTI-ARB] Series additions: "
                 f"{', '.join(f'{k}=+{v}' for k, v in series_new_counts.items())}")

    return all_events


def scan_multi_arb(client: KalshiClient, bankroll: float) -> list:
    """
    For events with 3+ mutually exclusive outcomes, the sum of all
    YES prices must equal 100c at resolution. If sum of YES asks < 98c,
    buying YES on every outcome locks in guaranteed profit.

    Example: candidates A=45c B=30c C=20c = 95c → 5c edge.
    Buy 1 contract of each for 95c, one MUST pay 100c → profit 5c.

    Scans ALL Kalshi categories (politics, economics, sports, crypto, etc.)
    targeting 300+ events per scan cycle.
    """
    opportunities = []
    events_scanned = 0
    events_exclusive = 0
    events_liquid = 0
    events_with_edge = 0

    all_events = _fetch_all_category_events(client)

    for e in all_events:
        evt_markets_raw = e.get("markets", [])
        if not isinstance(evt_markets_raw, list):
            continue

        event_ticker = e.get("event_ticker", "")
        event_title = e.get("title", "")

        # Skip blacklisted
        if event_ticker in EVENT_BLACKLIST:
            continue

        # Normalize — only active markets with prices
        legs = []
        for m in evt_markets_raw:
            if not isinstance(m, dict):
                continue
            ticker = m.get("ticker", "")
            if "KXMVE" in ticker:
                continue
            mstatus = m.get("status", "")
            if mstatus not in ("active", "open", ""):
                continue
            ya = _dollars_to_cents(m.get("yes_ask_dollars", "0"))
            yb = _dollars_to_cents(m.get("yes_bid_dollars", "0"))
            vol = int(float(m.get("volume_fp", "0")))
            vol24 = float(m.get("volume_24h_fp", "0"))
            if ya <= 0:
                continue
            legs.append({
                "ticker": ticker, "yes_ask": ya, "yes_bid": yb,
                "volume": vol, "vol24h": vol24,
                "no_ask": _dollars_to_cents(m.get("no_ask_dollars", "0")),
                "no_bid": _dollars_to_cents(m.get("no_bid_dollars", "0")),
                "status": mstatus,
            })

        if len(legs) < MULTI_ARB_MIN_LEGS:
            continue

        events_scanned += 1

        # Must be mutually exclusive
        tickers = [l["ticker"] for l in legs]
        if not _is_likely_exclusive(event_title, tickers):
            continue
        events_exclusive += 1

        # Every leg must have vol24h >= threshold
        illiquid = [l for l in legs if l["vol24h"] < MULTI_ARB_MIN_VOL_LEG]
        if illiquid:
            continue
        events_liquid += 1

        # Sum of all YES asks — must be < 98c for edge
        sum_yes_ask = sum(l["yes_ask"] for l in legs)
        edge_cents = 100 - sum_yes_ask

        if edge_cents < MULTI_ARB_MIN_EDGE:
            continue
        events_with_edge += 1

        # How many sets can we afford? (capped at $25 total)
        cost_per_set = sum_yes_ask / 100.0  # dollars
        if cost_per_set <= 0:
            continue
        max_sets = math.floor(min(MULTI_ARB_MAX_COST, bankroll * MAX_EVENT_PCT) / cost_per_set)
        if max_sets < 1:
            continue

        opportunities.append({
            "strategy":     "multi_arb",
            "event_ticker": event_ticker,
            "event_title":  event_title,
            "n_legs":       len(legs),
            "legs":         legs,
            "sum_yes_ask":  sum_yes_ask,
            "edge_cents":   edge_cents,
            "edge_pct":     edge_cents / 100.0,
            "contracts":    max_sets,
            "cost_usd":     cost_per_set * max_sets,
            "profit_usd":   edge_cents / 100.0 * max_sets,
        })

    # Sort by edge descending
    opportunities.sort(key=lambda x: x["edge_cents"], reverse=True)

    log.info(f"[MULTI-ARB] Scanned {events_scanned} events | "
             f"{events_exclusive} exclusive | {events_liquid} liquid | "
             f"{events_with_edge} with edge | {len(opportunities)} tradeable")

    for opp in opportunities[:5]:
        leg_summary = ",".join(f"{l['ticker'].split('-')[-1]}={l['yes_ask']}c" for l in opp["legs"][:6])
        if len(opp["legs"]) > 6:
            leg_summary += f"...+{len(opp['legs'])-6}"
        log.info(f"  {opp['event_ticker']:40s} sum={opp['sum_yes_ask']}c edge={opp['edge_cents']:+d}c "
                 f"{opp['contracts']}x ${opp['cost_usd']:.2f} -> ${opp['profit_usd']:.2f}")
        log.info(f"    legs=[{leg_summary}]")

    return opportunities


def execute_multi_arb(client: KalshiClient, opp: dict) -> bool:
    """Execute multi-outcome arb — buy YES on every leg."""
    global open_positions, trade_count, held_events, held_tickers

    event = opp["event_ticker"]
    contracts = opp["contracts"]
    legs = opp["legs"]

    # Duplicate guard
    if event in held_events:
        log.info(f"[MULTI-ARB] SKIP {event} — already held")
        return False

    leg_names = [l["ticker"].split("-")[-1] for l in legs]
    log.info(f"[DRY RUN] Would BUY multi-arb: {event} "
             f"legs=[{','.join(leg_names)}] "
             f"total_cost={opp['sum_yes_ask']}c edge={opp['edge_cents']}c "
             f"{contracts}x ${opp['cost_usd']:.2f} -> ${opp['profit_usd']:.2f}")

    if DRY_RUN:
        # Log the opportunity as taken (dry run)
        log_opportunity(int(time.time()), opp, taken=True, rejection_reason="dry_run")
        return True

    # Live execution
    filled = []
    for leg in legs:
        result = client.place_order(leg["ticker"], "yes", contracts, leg["yes_ask"])
        if result:
            filled.append(leg["ticker"])
        else:
            log.warning(f"[MULTI-ARB] Leg failed: {leg['ticker']} @ {leg['yes_ask']}c")
            break

    if not filled:
        return False

    trade_id = f"MARB_{event}_{int(time.time())}"
    trade_count += 1
    held_events.add(event)
    held_tickers.update(filled)

    # Create exit targets for filled legs
    create_exit_targets(trade_id, opp, "yes", [l for l in legs if l["ticker"] in filled], contracts)

    trade = {
        "id": trade_id, "ts": int(time.time()),
        "market": opp["event_title"][:100], "ticker": event,
        "strategy": "Multi-Arb", "side": "yes",
        "contracts": contracts * len(filled),
        "entry_yes_cents": opp["sum_yes_ask"], "entry_no_cents": None,
        "exit_yes_cents": None, "exit_no_cents": None,
        "edge_pct": opp["edge_pct"], "fill_rate": len(filled) / len(legs),
        "profit_cents": opp["edge_cents"] * contracts,
        "status": "open", "notes": f"{len(filled)}/{len(legs)} legs edge={opp['edge_cents']:+d}c"
    }
    log_trade(trade)
    open_positions[trade_id] = trade
    log_opportunity(int(time.time()), opp, taken=True)
    return True


# ─── STRATEGY: LOTTERY TICKETS (Momentum/Mispricing) ─────────
def scan_lottery(client: KalshiClient, bankroll: float) -> list:
    """
    Scan for extreme mispricing / momentum lottery tickets.
    Criteria: YES ask <= 5c ($0.05) AND volume_24h >= 5000.
    These are cheap long shots in active markets — small positions
    that can pay 20:1 if the event flips.
    """
    opportunities = []
    markets = client.get_markets(limit=1000)

    total = len(markets)
    skip_price = 0
    skip_volume = 0
    skip_no_ask = 0

    for m in markets:
        try:
            ticker     = m.get("ticker", "")
            yes_ask    = m.get("yes_ask", 0)
            volume_24h = m.get("volume_24h", 0)
            yes_bid    = m.get("yes_bid", 0)
            title      = m.get("title", ticker)

            if not yes_ask or yes_ask <= 0:
                skip_no_ask += 1
                continue

            # Must be cheap: YES ask <= 5 cents
            if yes_ask > LOTTERY_MAX_YES_ASK:
                skip_price += 1
                continue

            # Must have real volume
            if volume_24h < LOTTERY_MIN_VOL_24H:
                skip_volume += 1
                continue

            # Skip tickers we already hold
            if ticker in held_tickers:
                continue

            # Position sizing: max $10, buy at ask price
            max_dollars = min(LOTTERY_MAX_TRADE_USD, bankroll * 0.02)  # also cap at 2% bankroll
            contracts = contracts_for_dollars(max_dollars, yes_ask)
            contracts = min(contracts, LOTTERY_MAX_CONTRACTS)

            if contracts < 1:
                continue

            cost_usd = contracts * yes_ask / 100.0
            # Max payout if YES resolves: contracts * $1.00
            max_payout = contracts * 1.0
            potential_return = max_payout / cost_usd if cost_usd > 0 else 0

            vol_tier = "HIGH" if volume_24h >= LOTTERY_ALERT_VOL_24H else "OK"

            opportunities.append({
                "strategy":       "lottery",
                "ticker":         ticker,
                "market":         title[:100],
                "yes_ask":        yes_ask,
                "yes_bid":        yes_bid,
                "volume_24h":     volume_24h,
                "vol_tier":       vol_tier,
                "contracts":      contracts,
                "cost_usd":       cost_usd,
                "max_payout":     max_payout,
                "potential_return": potential_return,
            })

        except Exception as e:
            log.debug(f"Lottery scan error {m.get('ticker')}: {e}")

    # Sort by volume descending (most active cheap markets first)
    opportunities.sort(key=lambda x: x["volume_24h"], reverse=True)

    passed_price = total - skip_no_ask - skip_price
    log.info(f"[LOTTERY] Filter: {total} markets -> "
             f"{skip_no_ask} no ask, {skip_price} price>{LOTTERY_MAX_YES_ASK}c, "
             f"{passed_price} passed price filter, "
             f"{skip_volume} vol<{LOTTERY_MIN_VOL_24H} -> "
             f"{len(opportunities)} lottery candidates")

    for opp in opportunities[:5]:
        log.info(f"  [LOTTERY] {opp['ticker'][:40]:40s} YES@{opp['yes_ask']}c "
                 f"vol24h={opp['volume_24h']:.0f} [{opp['vol_tier']}] "
                 f"{opp['contracts']}x ${opp['cost_usd']:.2f} -> "
                 f"max ${opp['max_payout']:.2f} ({opp['potential_return']:.0f}:1)")

    return opportunities


def execute_lottery(client: KalshiClient, opp: dict) -> bool:
    """Execute a lottery ticket trade — buy YES on a cheap, active market."""
    global open_positions, trade_count, held_tickers

    ticker    = opp["ticker"]
    contracts = opp["contracts"]
    yes_ask   = opp["yes_ask"]

    # Duplicate guard
    if ticker in held_tickers:
        log.info(f"[LOTTERY] SKIP {ticker} — already held")
        return False

    log.info(f"[LOTTERY] {'[DRY RUN] ' if DRY_RUN else ''}BUY YES {contracts}x {ticker} "
             f"@ {yes_ask}c | cost=${opp['cost_usd']:.2f} | "
             f"max payout=${opp['max_payout']:.2f} ({opp['potential_return']:.0f}:1) | "
             f"vol24h={opp['volume_24h']:.0f}")

    if DRY_RUN:
        log_opportunity(int(time.time()), opp, taken=True, rejection_reason="dry_run")
        return True

    result = client.place_order(ticker, "yes", contracts, yes_ask)
    if not result:
        return False

    trade_id = f"LOTTERY_{ticker}_{int(time.time())}"
    trade_count += 1
    held_tickers.add(ticker)

    trade = {
        "id":              trade_id,
        "ts":              int(time.time()),
        "market":          opp["market"],
        "ticker":          ticker,
        "strategy":        "LOTTERY",
        "side":            "yes",
        "contracts":       contracts,
        "entry_yes_cents": yes_ask,
        "entry_no_cents":  None,
        "exit_yes_cents":  None,
        "exit_no_cents":   None,
        "edge_pct":        opp["potential_return"] / 100.0,
        "fill_rate":       1.0,
        "profit_cents":    0,  # unknown until resolution
        "status":          "open",
        "notes":           f"LOTTERY {opp['potential_return']:.0f}:1 vol={opp['volume_24h']:.0f}"
    }
    log_trade(trade)
    open_positions[trade_id] = trade
    log_opportunity(int(time.time()), opp, taken=True)

    log.info(f"  LOTTERY placed: {ticker} | {contracts}x @ {yes_ask}c = ${opp['cost_usd']:.2f}")
    return True


# ─── MAIN SCAN LOOP ────────────────────────────────────────────
def scan_and_trade(client: KalshiClient):
    """Main bot loop — scan markets and execute qualifying trades."""
    global session_pnl, trading_halted, DRY_RUN

    # ── Kill switch: check if trading should be halted ──
    if trading_halted:
        log.debug("Trading halted by kill switch — skipping scan")
        return

    if len(open_positions) >= MAX_POSITIONS:
        log.debug(f"At max positions ({MAX_POSITIONS}), skipping scan")
        return

    cash, port_val, total_value = client.get_total_value()
    bankroll = cash  # use cash for position sizing
    if total_value <= 0:
        log.warning("Could not fetch balance — skipping scan")
        return

    # ── Kill switch: 15% drawdown using TOTAL portfolio value ──
    if starting_balance > 0:
        drawdown = (starting_balance - total_value) / starting_balance
        if drawdown >= KILL_SWITCH_PCT:
            log.critical(
                f"KILL SWITCH TRIGGERED — Total value ${total_value:.2f} "
                f"(cash=${cash:.2f} + positions=${port_val:.2f}) is "
                f"{drawdown*100:.1f}% below starting ${starting_balance:.2f}. "
                f"ALL TRADING HALTED.")
            trading_halted = True
            return

    # ── Daily loss limit: auto-flip to dry run ──
    session_pnl = total_value - starting_balance
    if session_pnl < -MAX_DAILY_LOSS and not DRY_RUN:
        log.critical(
            f"DAILY LOSS LIMIT — Session P&L ${session_pnl:.2f} exceeds "
            f"-${MAX_DAILY_LOSS:.0f}. Switching to DRY RUN mode.")
        DRY_RUN = True

    log.info(f"Scanning... Cash: ${cash:.2f} | Positions: ${port_val:.2f} | "
             f"Total: ${total_value:.2f} | P&L: ${session_pnl:+.2f} | "
             f"Open: {len(open_positions)}/{MAX_POSITIONS} | "
             f"Held: {len(held_events)}evt {len(_exit_targets)}tgt")

    scan_start = time.time()
    scan_ts = int(scan_start)
    total_opps_found = 0
    total_opps_taken = 0
    total_markets = 0
    total_with_edge = 0

    # Auto-adjust position sizing based on track record
    update_position_sizing()

    # Check all exit conditions on open positions
    check_and_exit_positions(client)

    # YES/NO Arb
    if STRATEGIES.get("yes_no_arb"):
        opps = scan_yes_no_arb(client, bankroll)
        total_opps_found += len(opps)
        for opp in opps[:2]:  # max 2 arb trades per scan
            if len(open_positions) >= MAX_POSITIONS:
                break
            if execute_yes_no_arb(client, opp):
                total_opps_taken += 1
            time.sleep(0.5)  # small delay between orders

    # Multi-Outcome Arb (priority strategy)
    if STRATEGIES.get("multi_arb"):
        opps = scan_multi_arb(client, bankroll)
        total_opps_found += len(opps)
        for opp in opps[:2]:
            if len(open_positions) >= MAX_POSITIONS:
                break
            if execute_multi_arb(client, opp):
                total_opps_taken += 1
            time.sleep(0.5)

    # Multi-Leg Event Arb (DISABLED)
    if STRATEGIES.get("event_arb"):
        opps = scan_event_arb(client, bankroll)
        total_opps_found += len(opps)
        for opp in opps[:2]:  # max 2 event arb trades per scan
            if len(open_positions) >= MAX_POSITIONS:
                break
            if execute_event_arb(client, opp):
                total_opps_taken += 1
            time.sleep(0.5)

    # Cross-Platform
    if STRATEGIES.get("cross_platform"):
        opps = scan_cross_platform(client, bankroll)
        total_opps_found += len(opps)
        for opp in opps[:1]:  # max 1 cross-platform per scan
            if len(open_positions) >= MAX_POSITIONS:
                break
            if execute_cross_platform(client, opp):
                total_opps_taken += 1
            time.sleep(0.5)

    # Lottery Tickets (momentum/mispricing)
    if STRATEGIES.get("lottery"):
        opps = scan_lottery(client, bankroll)
        total_opps_found += len(opps)
        for opp in opps[:LOTTERY_MAX_PER_SCAN]:
            if len(open_positions) >= MAX_POSITIONS:
                break
            if execute_lottery(client, opp):
                total_opps_taken += 1
            time.sleep(0.5)

    # Log scan summary
    duration_ms = int((time.time() - scan_start) * 1000)
    active = ",".join(k for k, v in STRATEGIES.items() if v)
    log_scan_summary(scan_ts, bankroll, session_pnl, total_markets,
                     total_with_edge, total_opps_found, total_opps_taken,
                     active, duration_ms)

# ─── DAILY REPORT ──────────────────────────────────────────────
def generate_daily_report() -> dict:
    """Generate daily P&L report from database."""
    conn   = sqlite3.connect("apexpm.db")
    c      = conn.cursor()
    today  = datetime.date.today().isoformat()
    since  = int(time.time()) - 86400  # last 24 hours

    c.execute("SELECT * FROM trades WHERE ts > ? AND status != 'open'", (since,))
    trades = c.fetchall()
    conn.close()

    if not trades:
        return {"date": today, "trades": 0, "message": "No trades in last 24h"}

    columns   = ["id","ts","market","ticker","strategy","side","contracts",
                  "entry_yes","entry_no","exit_yes","exit_no",
                  "edge_pct","fill_rate","profit_cents","status","notes"]
    trade_dicts = [dict(zip(columns, t)) for t in trades]

    total     = len(trade_dicts)
    wins      = [t for t in trade_dicts if (t["profit_cents"] or 0) > 0]
    losses    = [t for t in trade_dicts if (t["profit_cents"] or 0) < 0]
    gross_pnl = sum(t["profit_cents"] or 0 for t in trade_dicts)
    win_rate  = len(wins)/total if total else 0
    best      = max(trade_dicts, key=lambda x: x["profit_cents"] or 0, default=None)
    worst     = min(trade_dicts, key=lambda x: x["profit_cents"] or 0, default=None)

    report = {
        "date":          today,
        "trades":        total,
        "wins":          len(wins),
        "losses":        len(losses),
        "gross_pnl_usd": gross_pnl / 100.0,
        "win_rate":      round(win_rate * 100, 1),
        "best_trade":    f"{best['market']} +${(best['profit_cents'] or 0)/100:.2f}" if best else "—",
        "worst_trade":   f"{worst['market']} ${(worst['profit_cents'] or 0)/100:.2f}" if worst else "—",
        "strategy_breakdown": {},
    }

    # Strategy breakdown
    for strat in set(t["strategy"] for t in trade_dicts):
        strat_trades = [t for t in trade_dicts if t["strategy"] == strat]
        strat_pnl    = sum(t["profit_cents"] or 0 for t in strat_trades)
        strat_wr     = len([t for t in strat_trades if (t["profit_cents"] or 0) > 0]) / len(strat_trades)
        report["strategy_breakdown"][strat] = {
            "trades":   len(strat_trades),
            "pnl_usd":  strat_pnl / 100.0,
            "win_rate": round(strat_wr * 100, 1),
        }

    log.info(f"\n{'='*50}\n📊 DAILY REPORT — {today}\n"
             f"Trades: {total} | Wins: {len(wins)} | Losses: {len(losses)}\n"
             f"P&L: ${gross_pnl/100:.2f} | Win Rate: {win_rate*100:.1f}%\n"
             f"Best: {report['best_trade']}\n"
             f"{'='*50}")

    # Save to DB
    conn = sqlite3.connect("apexpm.db")
    c    = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO daily_reports VALUES (?,?,?,?,?,?,?,?,?,?,?)
    """, (today, total, len(wins), len(losses),
          gross_pnl, 0, gross_pnl,
          win_rate,
          report["best_trade"], report["worst_trade"],
          json.dumps(report)))
    conn.commit()
    conn.close()

    if EMAIL_ENABLED:
        send_daily_email(report)

    return report

def send_daily_email(report: dict):
    """Send daily report via SendGrid (optional)."""
    if not SENDGRID_KEY or not REPORT_EMAIL:
        log.warning("Email enabled but SENDGRID_API_KEY or REPORT_EMAIL not set")
        return

    subject = f"ApexPM Daily Report — {report['date']} | P&L: ${report['gross_pnl_usd']:.2f}"
    body    = f"""
ApexPM Daily Trading Report
============================
Date:       {report['date']}
Trades:     {report['trades']}
Wins:       {report['wins']} ({report['win_rate']}%)
Losses:     {report['losses']}
Net P&L:    ${report['gross_pnl_usd']:.2f}

Best trade:  {report['best_trade']}
Worst trade: {report['worst_trade']}

Strategy Breakdown:
{json.dumps(report.get('strategy_breakdown',{}), indent=2)}

— ApexPM Bot
"""

    try:
        r = requests.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={
                "Authorization": f"Bearer {SENDGRID_KEY}",
                "Content-Type":  "application/json"
            },
            json={
                "personalizations": [{"to": [{"email": REPORT_EMAIL}]}],
                "from":    {"email": "apexpm-bot@yourdomain.com"},
                "subject": subject,
                "content": [{"type": "text/plain", "value": body}]
            },
            timeout=10
        )
        if r.status_code == 202:
            log.info(f"Daily report emailed to {REPORT_EMAIL}")
        else:
            log.warning(f"Email send failed: {r.status_code}")
    except Exception as e:
        log.error(f"Email error: {e}")

# ─── STARTUP CHECKS ────────────────────────────────────────────
def load_existing_positions(client: KalshiClient):
    """Load existing Kalshi positions into held_events/held_tickers
    so the bot doesn't re-enter positions it already holds."""
    global held_events, held_tickers

    data = client._get("/portfolio/positions")
    if not data:
        log.warning("Could not load existing positions")
        return

    # Market positions — individual tickers
    for p in data.get("market_positions", []):
        ticker = p.get("ticker", "")
        pos = float(p.get("position_fp", "0"))
        if pos != 0 and ticker:
            held_tickers.add(ticker)
            log.info(f"  Loaded position: {ticker} ({pos:.0f} contracts, "
                     f"exposure=${p.get('market_exposure_dollars', '0')})")

    # Event positions — event-level aggregates
    for ep in data.get("event_positions", []):
        evt = ep.get("event_ticker", "")
        cost = float(ep.get("total_cost_dollars", "0"))
        if cost > 0 and evt:
            held_events.add(evt)
            log.info(f"  Loaded event: {evt} (cost=${cost:.2f})")

    log.info(f"  Holding: {len(held_tickers)} market positions, "
             f"{len(held_events)} event positions")


def startup_checks(client: KalshiClient) -> bool:
    """Verify API connection, load state, set kill-switch baseline."""
    global starting_balance

    log.info("="*50)
    log.info("ApexPM Bot Starting Up")
    log.info(f"Mode:     {'DRY RUN' if DRY_RUN else '🔴 LIVE TRADING'}")
    log.info(f"Env:      {'DEMO' if USE_DEMO else 'PRODUCTION'}")
    log.info(f"Base URL: {BASE_URL}")
    log.info("="*50)

    cash, port_val, total = client.get_total_value()
    if total == 0.0:
        log.error("Could not fetch balance — check API credentials")
        return False

    starting_balance = total
    log.info(f"Starting value: ${total:.2f} (cash=${cash:.2f} + positions=${port_val:.2f}) | "
             f"Kill switch at: ${total * (1 - KILL_SWITCH_PCT):.2f} "
             f"(-{KILL_SWITCH_PCT*100:.0f}%) | "
             f"Max daily loss: ${MAX_DAILY_LOSS:.0f}")

    # Load existing positions so we don't re-enter them
    log.info("Loading existing positions from Kalshi...")
    load_existing_positions(client)
    load_exit_targets()

    positions = client.get_positions()
    log.info(f"Connected | Cash: ${cash:.2f} | Positions: ${port_val:.2f} | "
             f"API positions: {len(positions)} | "
             f"Tracked events: {held_events or 'none'}")

    if not DRY_RUN:
        log.warning("LIVE TRADING MODE — real orders will be placed")
        log.info("Starting in 10 seconds... Ctrl+C to abort")
        time.sleep(10)

    return True

# ─── MAIN ──────────────────────────────────────────────────────
# ─── WEBSOCKET PRICE STREAMING ────────────────────────────────
class KalshiWebSocket:
    """
    Real-time price streaming via Kalshi WebSocket API.
    Subscribes to orderbook_delta for held tickers.
    On price update, immediately runs exit check — no polling delay.
    Falls back to REST polling if websocket-client is not installed.
    """
    WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2"

    def __init__(self, auth: KalshiAuth, client: KalshiClient):
        self.auth = auth
        self.client = client
        self._ws = None
        self._thread = None
        self._running = False
        self._subscribed_tickers = set()
        # Live price cache: ticker -> {yes_bid, no_bid}
        self.prices = {}

    def _connect(self):
        """Open authenticated WebSocket connection."""
        ts_ms = str(int(time.time() * 1000))
        msg_str = ts_ms + "GET" + "/trade-api/ws/v2"
        sig = self.auth.private_key.sign(
            msg_str.encode("utf-8"),
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                        salt_length=padding.PSS.MAX_LENGTH),
            hashes.SHA256()
        )
        headers = [
            f"KALSHI-ACCESS-KEY: {self.auth.key_id}",
            f"KALSHI-ACCESS-TIMESTAMP: {ts_ms}",
            f"KALSHI-ACCESS-SIGNATURE: {base64.b64encode(sig).decode()}",
        ]
        self._ws = _ws_mod.create_connection(self.WS_URL, timeout=10, header=headers)
        log.info("[WS] Connected to Kalshi WebSocket")

    def subscribe(self, tickers: list):
        """Subscribe to orderbook_delta for given tickers."""
        if not self._ws:
            return
        new = [t for t in tickers if t not in self._subscribed_tickers]
        if not new:
            return
        msg = {"id": int(time.time()), "cmd": "subscribe",
               "params": {"channels": ["orderbook_delta"], "market_tickers": new}}
        self._ws.send(json.dumps(msg))
        self._subscribed_tickers.update(new)
        log.info(f"[WS] Subscribed to {len(new)} tickers ({len(self._subscribed_tickers)} total)")

    def _process_message(self, raw: str):
        """Parse WS message, update price cache, trigger exit check."""
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            return

        msg_type = d.get("type", "")

        if msg_type == "orderbook_snapshot":
            m = d.get("msg", {})
            ticker = m.get("market_ticker", "")
            yes_levels = m.get("yes_dollars_fp", [])
            no_levels = m.get("no_dollars_fp", [])
            # Best bid = highest price in the book
            yes_bid = int(float(yes_levels[-1][0]) * 100) if yes_levels else 0
            no_bid = int(float(no_levels[-1][0]) * 100) if no_levels else 0
            self.prices[ticker] = {"yes_bid": yes_bid, "no_bid": no_bid}
            self._check_exit_fast(ticker)

        elif msg_type == "orderbook_delta":
            m = d.get("msg", {})
            ticker = m.get("market_ticker", "")
            # Delta may update price levels — re-extract best bid
            for side_key, bid_key in [("yes_dollars_fp", "yes_bid"), ("no_dollars_fp", "no_bid")]:
                levels = m.get(side_key)
                if levels:
                    best = int(float(levels[-1][0]) * 100) if levels else 0
                    if ticker not in self.prices:
                        self.prices[ticker] = {"yes_bid": 0, "no_bid": 0}
                    self.prices[ticker][bid_key] = best
            self._check_exit_fast(ticker)

    def _check_exit_fast(self, ticker: str):
        """Instant exit check using cached WS price. Order first, log after."""
        tgt = _exit_targets.get(ticker)
        if not tgt:
            return

        prices = self.prices.get(ticker, {})
        side = tgt["side"]
        bid = prices.get("yes_bid", 0) if side == "yes" else prices.get("no_bid", 0)
        if bid <= 0:
            return

        now = int(time.time())
        stop = tgt["stop_loss"]
        target = tgt["target_exit"]
        momentum = tgt["momentum_exit"]
        max_ts = tgt["max_hold_ts"]
        entry_price = tgt["entry_price"]
        entry_ts = tgt.get("entry_ts", 0)
        contracts = tgt["contracts"]

        exit_reason = None
        if now >= max_ts:
            exit_reason = "time_exit"
        elif bid <= stop and (now - entry_ts) >= STOP_LOSS_COOLDOWN:
            exit_reason = "stop_loss"
        elif bid >= target:
            exit_reason = "convergence_exit"

        if not exit_reason:
            return

        # FIRE ORDER FIRST
        if not DRY_RUN:
            result = self.client.place_order(ticker, side, contracts, bid)
            if not result:
                return
        else:
            log.info(f"[WS EXIT] [DRY RUN] {ticker} {exit_reason} bid={bid}c")

        entry_ts = tgt.get("entry_ts", now)
        hold_hours = round((now - entry_ts) / 3600.0, 2)
        profit_cents = (bid - entry_price) * contracts
        hit_plan = 1 if exit_reason in ("convergence_exit", "momentum_exit") else 0

        log.info(f"[WS EXIT] {ticker} {exit_reason}: entry={entry_price}c exit={bid}c "
                 f"hold={hold_hours:.1f}h P&L=${profit_cents/100:.2f}")

        # Log to DB
        try:
            conn = sqlite3.connect("apexpm.db")
            c = conn.cursor()
            c.execute("""
                INSERT INTO trade_exits
                (trade_id, exit_ts, ticker, side, contracts,
                 entry_price_cents, exit_price_cents, hold_time_hours,
                 profit_cents, profit_usd, exit_reason,
                 plan_target_cents, plan_stop_cents, hit_plan)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (tgt["trade_id"], now, ticker, side, contracts,
                  entry_price, bid, hold_hours, profit_cents,
                  round(profit_cents/100, 4), exit_reason,
                  target, stop, hit_plan))
            conn.commit()
            conn.close()
        except Exception:
            pass

        del _exit_targets[ticker]

    def _run_loop(self):
        """Background thread: read WS messages and process them."""
        while self._running:
            try:
                if not self._ws:
                    self._connect()
                    # Subscribe to all currently held tickers
                    if _exit_targets:
                        self.subscribe(list(_exit_targets.keys()))

                raw = self._ws.recv()
                self._process_message(raw)

            except Exception as e:
                log.warning(f"[WS] Error: {e} — reconnecting in 5s")
                self._ws = None
                time.sleep(5)

    def start(self):
        """Start WebSocket in background thread."""
        if not HAS_WEBSOCKET:
            log.info("[WS] websocket-client not installed — using REST polling fallback")
            return False
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        log.info("[WS] Background price streaming started")
        return True

    def stop(self):
        """Shut down WebSocket."""
        self._running = False
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
        log.info("[WS] Stopped")

    def update_subscriptions(self):
        """Call after new trades to subscribe to newly held tickers."""
        if self._ws and _exit_targets:
            self.subscribe(list(_exit_targets.keys()))


# ─── MAIN ──────────────────────────────────────────────────────
def main():
    b64_key = os.getenv("KALSHI_PRIVATE_KEY_B64", "")
    if not API_KEY_ID or (not PRIVATE_KEY_PEM and not b64_key):
        log.error("KALSHI_API_KEY_ID and either KALSHI_PRIVATE_KEY_PEM or KALSHI_PRIVATE_KEY_B64 must be set")
        return

    init_db()

    auth   = KalshiAuth(API_KEY_ID, PRIVATE_KEY_PEM)
    client = KalshiClient(auth)

    if not startup_checks(client):
        return

    # Start WebSocket price streaming (falls back to REST if unavailable)
    ws_stream = KalshiWebSocket(auth, client)
    ws_active = ws_stream.start()

    schedule.every(SCAN_INTERVAL).seconds.do(scan_and_trade, client=client)
    schedule.every().day.at("21:00").do(generate_daily_report)

    mode = "WebSocket + REST scan" if ws_active else "REST polling"
    log.info(f"Mode: {mode} | Scanning every {SCAN_INTERVAL}s | Daily report at 21:00")
    log.info("Bot running. Ctrl+C to stop.\n")

    # Run immediately on start
    scan_and_trade(client)
    ws_stream.update_subscriptions()

    while True:
        try:
            schedule.run_pending()

            # If WS is not active, run REST exit check as fallback
            if not ws_active:
                check_and_exit_positions(client)

            # Update WS subscriptions if new targets were added
            if ws_active:
                ws_stream.update_subscriptions()

            time.sleep(1)
        except KeyboardInterrupt:
            log.info("\nBot stopped by user")
            ws_stream.stop()
            generate_daily_report()
            break
        except Exception as e:
            log.error(f"Unexpected error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    main()
