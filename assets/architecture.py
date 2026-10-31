"""Source of assets/apexpm-v3-architecture.{svg,png}. Run: python3 assets/architecture.py (needs playwright for the PNG)."""
import html

W, H = 1460, 1400
F = "Inter, 'IBM Plex Sans', Helvetica, Arial, sans-serif"
INK, MUTED, DIM = "#1d1f24", "#3b4049", "#6b7078"
BLUE, GREEN, GOLD, RED, GREY, PURPLE = "#5b7a99", "#2f7d4f", "#b8912a", "#c0392b", "#8a8578", "#7a5b99"
out = []


def t(x, y, s, size=15, weight=400, fill=MUTED, anchor="middle", extra=""):
    out.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{F}" font-size="{size}" font-weight="{weight}" fill="{fill}" {extra}>{html.escape(s)}</text>')


def box(x, y, w, h, title, lines, stroke=BLUE, fill="#eef2f7", title_size=18, dim_last=False):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
    cx = x + w / 2
    t(cx, y + 30, title, 18 if title_size == 18 else title_size, 600, INK)
    for i, ln in enumerate(lines):
        last = dim_last and i == len(lines) - 1
        t(cx, y + 56 + i * 21, ln, 13 if last else 15, 400, DIM if last else MUTED)


def band(x, y, w, h, label):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="#f7f6f2" stroke="#c9c6bb" stroke-width="1.5" stroke-dasharray="6 4"/>')
    t(x + 16, y + 26, label, 14, 600, DIM, "start", 'letter-spacing="1"')


def arrow(x1, y1, x2, y2, color=BLUE, dashed=False):
    d = ' stroke-dasharray="7 5"' if dashed else ""
    m = "ahg" if color == GREEN else "ah"
    out.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="2.5"{d} marker-end="url(#{m})"/>')


def pill(x, y, s):
    w = len(s) * 7.2 + 24
    out.append(f'<rect x="{x - w / 2}" y="{y - 13}" width="{w}" height="24" rx="6" fill="#fff" stroke="#c9c6bb"/>')
    t(x, y + 4, s, 13, 400, MUTED)


out.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
out.append('<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5b7a99"/></marker>'
           '<marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#2f7d4f"/></marker></defs>')
out.append(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
t(40, 26, "APEXPM — HOW THE BOT RUNS, DECIDES, PROTECTS ITSELF AND LEARNS", 13, 600, DIM, "start", 'letter-spacing="1"')

# 1 data
band(40, 40, 1320, 150, "1 · DATA INGESTION")
box(69, 80, 380, 90, "Kalshi", ["live orderbooks + market data", "endpoint-fenced: can never move funds"])
box(499, 80, 400, 90, "Crypto spot feeds", ["multiple venues, cross-checked", "if they disagree, no trade"])
box(949, 80, 380, 90, "Sports data", ["live scores during games", "pre-game lines"])

# 2 strategy
band(40, 232, 1320, 178, "2 · STRATEGY LAYER")
t(285, 258, "two loops drive every trade", 13, 400, DIM, "start")
box(69, 270, 621, 120, "Slow loop · the scanner", ["market regime check → strategy scans", "arbitrage · pricing models · line value", "finds and enters new trades"])
box(719, 270, 610, 120, "Fast loop · real time", ["manages the exit plan of every open position", "in-game sports strategies", "reacts within seconds of a score change"])
arrow(259, 170, 259, 268); arrow(699, 170, 699, 268); arrow(1139, 170, 1139, 268)

# 3 gates
box(431, 450, 540, 96, "3 · Governance gates, in order", ["not halted → strategy active → regime allows →", "risk governor caps & streaks → position limits"], fill="#e9eef5")
arrow(390, 390, 600, 448); arrow(1010, 390, 800, 448)

# 4 execution
band(40, 593, 1320, 146, "4 · EXECUTION — THREE BOOKS")
box(69, 629, 398, 90, "Paper", ["simulated against the real orderbook", "real depth, real fees"], GREEN, "#eaf3ea")
box(499, 629, 400, 90, "Shadow", ["same simulation, no cash — benched or", "blocked strategies keep a full record"], GOLD, "#fbf5e2")
box(929, 629, 400, 90, "Live", ["real orders, only when every live lock", "is opened by the owner"], RED, "#f9e8e5")
arrow(520, 546, 310, 627); pill(431, 588, "allowed")
arrow(699, 546, 699, 627); pill(699, 588, "benched / blocked")
arrow(850, 546, 1090, 627, BLUE, True); pill(970, 588, "live locks open")

# 5 journal, 6 dashboard
box(69, 790, 621, 96, "5 · Journal", ["every trade, fill, plan, scan", "and every candidate not taken"], GREY, "#ecebe6")
box(719, 790, 610, 96, "6 · Dashboard + API", ["phone-first web app: positions, activity,", "analytics, reports, manual trading · secure pairing"])
arrow(269, 719, 269, 788); arrow(699, 719, 430, 788); arrow(1129, 719, 560, 788); pill(845, 757, "exits & settlements → records")
arrow(690, 838, 717, 838)

# 7 judgment, 8 lifecycle
box(69, 939, 621, 110, "7 · Judgment", ["nightly calibration · weekly post-mortem", "missed winners, good avoids, research export"])
box(719, 939, 610, 110, "8 · Lifecycle", ["ACTIVE → QUARANTINE automatically when losing beyond noise", "QUARANTINE → ACTIVE only by a human"])
arrow(379, 886, 379, 937); arrow(690, 994, 717, 994); pill(704, 996, "evidence")
# lifecycle sets the gate
out.append(f'<path d="M1329,994 L1385,994 L1385,498 L973,498" fill="none" stroke="{BLUE}" stroke-width="2.5" marker-end="url(#ah)"/>')
t(1372, 760, "lifecycle sets the gate", 13, 400, MUTED, "middle", 'transform="rotate(-90 1372 760)"')

# 9 lab
box(69, 1089, 1260, 110, "9 · The Lab — strategy R&D",
    ["variants: same strategy code, different settings, tested in the shadow book · scoreboard: variant vs base",
     "tune · retire · spawn — strategy changes arrive only as evidence-backed proposals",
     "proposals go to the owner; nothing is applied automatically — the bot stays deterministic"], GREEN, "#eaf3ea", dim_last=True)
arrow(379, 1049, 379, 1087); arrow(1024, 1049, 1024, 1087)
out.append(f'<path d="M1329,1144 L1423,1144 L1423,528 L973,528" fill="none" stroke="{GREEN}" stroke-width="2.5" stroke-dasharray="7 5" marker-end="url(#ahg)"/>')
t(1410, 760, "approved proposals → new rules at the gate", 13, 400, GREEN, "middle", 'transform="rotate(-90 1410 760)"')

# 10 daily audit (outside the bot)
box(69, 1239, 1260, 120, "10 · Daily audit — the build's independent reviewer, outside the bot",
    ["a fresh session reads the nightly research bundle, the code, every spec and yesterday's audit · re-derives formulas · checks caps, exits, lifecycle, Lab, fills, fees, infra",
     "ships correctness and infra fixes with tests · writes an audit file · anything that changes money behavior becomes a proposal with the diff ready",
     "holds no token and no key: it can read and propose, never trade · a separate health alert watches the service every 10 minutes"], PURPLE, "#f3eef7", dim_last=True)
arrow(699, 1199, 699, 1237, PURPLE) if False else out.append(f'<line x1="699" y1="1199" x2="699" y2="1237" stroke="{PURPLE}" stroke-width="2.5" marker-end="url(#ah)"/>')
out.append("</svg>")

svg = "\n".join(out)
open("assets/apexpm-v3-architecture.svg", "w").write(svg)
print("svg written")

try:
    import asyncio
    from playwright.async_api import async_playwright

    async def main():
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page(viewport={"width": W, "height": H}, device_scale_factor=2)
            await pg.set_content("<html><body style='margin:0;background:#fff'>" + svg + "</body></html>")
            await pg.wait_for_timeout(300)
            await pg.screenshot(path="assets/apexpm-v3-architecture.png", clip={"x": 0, "y": 0, "width": W, "height": H})
            await b.close()
    asyncio.run(main())
    print("png written")
except Exception as e:
    print("png skipped:", e)
