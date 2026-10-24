import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell
} from "recharts";

/* ─── FONTS ──────────────────────────────────────────────────── */
const FontLink = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:wght@400;600;700&family=DM+Sans:wght@400;500;600&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#07070f}
    ::-webkit-scrollbar{width:4px}
    ::-webkit-scrollbar-track{background:#0d0d1a}
    ::-webkit-scrollbar-thumb{background:#252540;border-radius:2px}
    @keyframes slideIn{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
    @keyframes scanline{0%{transform:scaleX(.15);opacity:.4}50%{transform:scaleX(1);opacity:1}100%{transform:scaleX(.15);opacity:.4}}
    @keyframes fadeOut{from{opacity:1}to{opacity:.35}}
    @keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
    .slide{animation:slideIn .2s ease forwards}
    .pulse{animation:pulse 2s infinite}
    .scanline{animation:scanline 2s infinite;transform-origin:left}
    .fade{animation:fadeOut .5s ease forwards;animation-fill-mode:both}
  `}</style>
);

/* ─── THEME ──────────────────────────────────────────────────── */
const C = {
  bg:"#07070f", surface:"#0d0d1a", card:"#111120",
  border:"#1a1a32", borderHi:"#252545",
  accent:"#00e5ff", green:"#00e87a", red:"#ff2d55",
  amber:"#ffaa00", purple:"#a855f7", pink:"#ec4899", orange:"#f97316",
  teal:"#14b8a6", sky:"#38bdf8",
  text:"#c8d4f0", dim:"#6b7299", muted:"#2e2e50",
};

/* ─── CONSTANTS ──────────────────────────────────────────────── */
const START_BANKROLL     = 500;
const KELLY_FRACTION     = 0.25;
const MAX_POS_PCT        = 0.12;
const MAX_POSITIONS      = 6;
const PROFIT_CAPTURE_PCT = 0.72;
const MAX_HOLD_MS        = 45000;

const RULES = {
  minEdge:0.025, minWinProb:0.75, minFillRate:0.65,
  minLiquidity:100, minProfit:0.50, maxConvPct:65,
  strongEdge:0.04, strongProb:0.85,
};

/* ─── KALSHI MARKETS (execution) ─────────────────────────────── */
// poly:true means Polymarket also has this market → used for price discovery
// exec: always Kalshi
const MARKETS = [
  {name:"BTC 1-Hour Up/Down",        cat:"Crypto",   poly:true,  ticker:"KXBTC"},
  {name:"ETH 15-Min Up/Down",        cat:"Crypto",   poly:true,  ticker:"KXETH"},
  {name:"SOL 15-Min Up/Down",        cat:"Crypto",   poly:true,  ticker:"KXSOL"},
  {name:"BTC above $90k Apr 30",     cat:"Crypto",   poly:true,  ticker:"KXBTCRANGE"},
  {name:"ETH above $2k Apr 30",      cat:"Crypto",   poly:true,  ticker:"KXETHRANGE"},
  {name:"Fed cuts rates May 2026",    cat:"Macro",    poly:true,  ticker:"KXFED"},
  {name:"US CPI below 3% March",     cat:"Macro",    poly:false, ticker:"KXCPI"},
  {name:"S&P 500 positive April",    cat:"Macro",    poly:true,  ticker:"KXSPX"},
  {name:"Gold above $3100 Apr",      cat:"Macro",    poly:true,  ticker:"KXGOLD"},
  {name:"Trump approval >50%",       cat:"Politics", poly:true,  ticker:"KXAPPROVAL"},
  {name:"Senate flips 2026",         cat:"Politics", poly:true,  ticker:"KXSENATE"},
  {name:"GOP wins NH-2 special",     cat:"Politics", poly:true,  ticker:"KXNH2"},
  {name:"OKC wins NBA West",         cat:"Sports",   poly:false, ticker:"KXNBA"},
  {name:"Yankees make playoffs",     cat:"Sports",   poly:false, ticker:"KXYANKEES"},
  {name:"Tesla Q1 >400k deliveries", cat:"Corp",     poly:true,  ticker:"KXTSLA"},
  {name:"XRP above $2.50 Apr 30",    cat:"Crypto",   poly:true,  ticker:"KXXRP"},
];

const STRATEGIES = [
  {id:"yes_no",  label:"YES/NO Arb",     desc:"YES+NO < $1 on Kalshi → guaranteed profit at settlement", risk:"Very Low", baseWR:0.97, color:C.accent, fastConverge:true,  exec:"Kalshi"},
  {id:"x_plat",  label:"Cross-Platform", desc:"Polymarket price oracle detects gap → execute on Kalshi", risk:"Low",      baseWR:0.89, color:C.green,  fastConverge:true,  exec:"Kalshi (Poly signal)"},
  {id:"logical", label:"Logical Corr",   desc:"Correlated Kalshi markets with impossible relative pricing",risk:"Low",     baseWR:0.84, color:C.amber,  fastConverge:false, exec:"Kalshi"},
  {id:"latency", label:"Latency Arb",    desc:"Futures signal leads Kalshi by seconds",                  risk:"Medium",   baseWR:0.74, color:C.orange, fastConverge:true,  exec:"Kalshi"},
  {id:"mm",      label:"Market Making",  desc:"Post both sides of Kalshi order book to earn spread",     risk:"Medium",   baseWR:0.78, color:C.purple, fastConverge:false, exec:"Kalshi"},
  {id:"niche",   label:"AI Niche",       desc:"Claude-identified low-competition Kalshi markets",         risk:"Variable", baseWR:0.71, color:C.pink,   fastConverge:false, exec:"Kalshi"},
];

/* ─── MATH ───────────────────────────────────────────────────── */
const kellyF  = (p, b) => Math.max(0, (p*b-(1-p))/b);
const posSize = (edge, prob, br) => {
  const b = edge>0.99?9:Math.max(0.1,(1/(1-edge+0.01))-1);
  return Math.min(kellyF(prob,b)*KELLY_FRACTION*br, MAX_POS_PCT*br);
};
const sharpeR = rs => {
  if(rs.length<2) return 0;
  const mu=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sig=Math.sqrt(rs.map(r=>(r-mu)**2).reduce((a,b)=>a+b,0)/rs.length);
  return sig===0?0:(mu/sig)*Math.sqrt(365);
};
const sortinoR = rs => {
  if(rs.length<2) return 0;
  const mu=rs.reduce((a,b)=>a+b,0)/rs.length;
  const downDev=Math.sqrt(rs.filter(r=>r<0).map(r=>r*r).reduce((a,b)=>a+b,0)/Math.max(1,rs.length));
  return downDev===0?0:(mu/downDev)*Math.sqrt(365);
};
const maxDD = eq => {
  let pk=eq[0]||0,dd=0;
  for(const v of eq){pk=Math.max(pk,v);dd=Math.max(dd,(pk-v)/(pk||1));}
  return dd;
};
const profitFactor = log => {
  const g=log.filter(t=>t.profit>0).reduce((a,t)=>a+t.profit,0);
  const l=Math.abs(log.filter(t=>t.profit<0).reduce((a,t)=>a+t.profit,0));
  return l===0?(g>0?999:0):g/l;
};
const expectancy = log => {
  if(!log.length) return 0;
  const wr=log.filter(t=>t.profit>0).length/log.length;
  const avgW=log.filter(t=>t.profit>0).reduce((a,t)=>a+t.profit,0)/Math.max(1,log.filter(t=>t.profit>0).length);
  const avgL=Math.abs(log.filter(t=>t.profit<0).reduce((a,t)=>a+t.profit,0)/Math.max(1,log.filter(t=>t.profit<0).length));
  return wr*avgW-(1-wr)*avgL;
};

const fmt$  = n=>`${n>=0?"+":"-"}$${Math.abs(n).toFixed(2)}`;
const fmtP  = n=>`${(n*100).toFixed(1)}%`;
const uid   = ()=>Math.random().toString(36).slice(2,8);
const ms2s  = ms=>`${(ms/1000).toFixed(1)}s`;
const clock = ms=>{
  if(!ms) return "0:00";
  const e=Math.max(0,Date.now()-ms)/1000;
  return `${Math.floor(e/60)}:${String(Math.floor(e%60)).padStart(2,"0")}`;
};
const fmtDate = ts => {
  if(!ts) return "—";
  const d=new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
};

/* ─── SCORING ENGINE ─────────────────────────────────────────── */
function scoreOpp(opp, openPositions, bankroll, convPct) {
  const failures=[];
  if(opp.edge<RULES.minEdge)           failures.push(`Edge ${fmtP(opp.edge)} < ${fmtP(RULES.minEdge)}`);
  if(opp.prob<RULES.minWinProb)        failures.push(`Win prob ${fmtP(opp.prob)} < ${fmtP(RULES.minWinProb)}`);
  if(opp.fillRate<RULES.minFillRate)   failures.push(`Fill ${fmtP(opp.fillRate)} < ${fmtP(RULES.minFillRate)}`);
  if(opp.liquidity<RULES.minLiquidity) failures.push(`Liquidity $${opp.liquidity.toFixed(0)} < $${RULES.minLiquidity}`);
  if(opp.maxProfit<RULES.minProfit)    failures.push(`Profit $${opp.maxProfit.toFixed(2)} < $${RULES.minProfit}`);
  if(convPct>RULES.maxConvPct)         failures.push(`Spread ${convPct.toFixed(0)}% converged`);
  if(openPositions>=MAX_POSITIONS)     failures.push(`${MAX_POSITIONS} positions open`);
  if(opp.actualSize>bankroll*0.95)     failures.push(`Insufficient bankroll`);
  const passes=failures.length===0;
  const score=Math.round(
    Math.min(40,(opp.edge/0.10)*40)+
    Math.min(25,((opp.prob-0.5)/0.5)*25)+
    Math.min(20,opp.fillRate*20)+
    Math.min(15,(opp.liquidity/500)*15)
  );
  let grade;
  if(!passes) grade="SKIP";
  else if(opp.edge>=RULES.strongEdge&&opp.prob>=RULES.strongProb) grade="STRONG";
  else if(score>=55) grade="GOOD";
  else grade="MARGINAL";
  return{grade,score,passes,failures,autoEligible:passes&&grade!=="MARGINAL"};
}

const GRADE_META={
  STRONG:{color:C.green,  label:"● STRONG"},
  GOOD:  {color:C.accent, label:"● GOOD"},
  MARGINAL:{color:C.amber,label:"◐ MARGINAL"},
  SKIP:  {color:C.dim,    label:"○ SKIP"},
};

/* ─── OPP GENERATOR ─────────────────────────────────────────── */
function genOpp(stratId, bankroll) {
  const mkt   = MARKETS[Math.floor(Math.random()*MARKETS.length)];
  const strat = STRATEGIES.find(s=>s.id===stratId)||STRATEGIES[0];
  let yes,no,edge,prob,platform,note,convergenceMs;

  if(stratId==="yes_no"){
    yes=0.44+Math.random()*0.09; no=Math.min(0.96-yes,0.45+Math.random()*0.08);
    edge=Math.max(0.01,1-yes-no); prob=0.97;
    platform="Kalshi";
    note=`Kalshi YES $${yes.toFixed(3)} + NO $${no.toFixed(3)} = $${(yes+no).toFixed(3)} (gap $${edge.toFixed(3)})`;
    convergenceMs=3000+Math.random()*8000;
  } else if(stratId==="x_plat"){
    yes=0.45+Math.random()*0.13; no=0.41+Math.random()*0.11;
    edge=Math.max(0.01,1-yes-no); prob=0.89;
    platform="Kalshi";
    note=`Poly oracle: YES $${yes.toFixed(3)} | Kalshi NO $${no.toFixed(3)} → execute on Kalshi`;
    convergenceMs=4000+Math.random()*12000;
  } else if(stratId==="logical"){
    const parent=0.33+Math.random()*0.22; const child=parent+0.03+Math.random()*0.08;
    edge=Math.max(0.02,child-parent); prob=0.84;
    platform="Kalshi";
    note=`Kalshi: parent $${parent.toFixed(3)}, child implies ≥ $${child.toFixed(3)}`;
    yes=parent; no=1-parent;
    convergenceMs=8000+Math.random()*20000;
  } else if(stratId==="latency"){
    const dir=Math.random()>0.5?"BULLISH":"BEARISH";
    const lag=2000+Math.random()*9000;
    edge=0.035+Math.random()*0.09; prob=0.74;
    platform="Kalshi";
    yes=0.5+(dir==="BULLISH"?1:-1)*(0.04+Math.random()*0.08); no=1-yes;
    note=`${dir} futures signal | Kalshi lag ~${(lag/1000).toFixed(1)}s`;
    convergenceMs=lag+1000;
  } else if(stratId==="mm"){
    const mid=0.48+Math.random()*0.08; const spr=0.018+Math.random()*0.025;
    edge=spr/2; prob=0.78; platform="Kalshi";
    yes=mid-spr/2; no=1-(mid+spr/2);
    note=`Kalshi MM: mid $${mid.toFixed(3)} spread $${(spr*100).toFixed(1)}¢`;
    convergenceMs=15000+Math.random()*30000;
  } else {
    edge=0.03+Math.random()*0.14; prob=0.63+Math.random()*0.18;
    platform="Kalshi"; yes=0.28+Math.random()*0.44; no=1-yes;
    note=`AI niche: ${(Math.random()*70+10).toFixed(0)} traders, low competition`;
    convergenceMs=10000+Math.random()*28000;
  }

  const fillRate=0.52+Math.random()*0.48;
  const size=posSize(edge,prob,bankroll);
  const actualSize=size*fillRate;
  return{
    id:uid(), market:mkt.name, category:mkt.cat, ticker:mkt.ticker,
    strategy:strat.label, strategyId:stratId, strategyColor:strat.color,
    platform, yesPrice:yes, noPrice:no, edge, prob,
    kellySize:size, fillRate, actualSize, maxProfit:actualSize*edge,
    liquidity:40+Math.random()*480, note, risk:strat.risk,
    fastConverge:strat.fastConverge, execLatencyMs:50+Math.random()*250,
    convergenceMs, ts:Date.now(), status:"pending", positionId:null,
    polySignal: mkt.poly && stratId==="x_plat",
  };
}

/* ════════════════════════════════════════════════════════════
   ATOMS
════════════════════════════════════════════════════════════ */
const Badge = ({color,children,tiny,solid})=>(
  <span style={{background:solid?color:`${color}18`,color:solid?(color===C.amber?C.bg:"#fff"):color,
    border:`1px solid ${color}${solid?"":"38"}`,borderRadius:3,padding:tiny?"0 5px":"2px 8px",
    fontSize:tiny?8:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:700,letterSpacing:".05em",whiteSpace:"nowrap"}}>
    {children}
  </span>
);

const Btn = ({children,onClick,color=C.accent,fill,small,disabled,danger})=>(
  <button onClick={onClick} disabled={disabled} style={{
    background:fill?(danger?C.red:color):"transparent",
    color:fill?(color===C.green||danger?C.bg:"#fff"):(danger?C.red:color),
    border:`1px solid ${danger?C.red:color}`,borderRadius:5,
    padding:small?"3px 10px":"7px 18px",fontSize:small?10:12,
    fontFamily:"'DM Sans',sans-serif",fontWeight:600,cursor:disabled?"not-allowed":"pointer",
    opacity:disabled?.4:1,transition:"all .15s",letterSpacing:".04em",flexShrink:0,
  }}>{children}</button>
);

const Toggle=({on,onChange,color=C.green})=>(
  <div onClick={()=>onChange(!on)} style={{width:38,height:20,borderRadius:10,
    background:on?color:`${C.muted}80`,cursor:"pointer",position:"relative",
    transition:"background .18s",flexShrink:0}}>
    <div style={{width:16,height:16,borderRadius:8,background:"#fff",position:"absolute",
      top:2,left:on?20:2,transition:"left .18s"}}/>
  </div>
);

const Metric=({label,value,sub,color=C.accent,small})=>(
  <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,
    padding:small?"9px 12px":"12px 14px",flex:1,minWidth:90}}>
    <div style={{color:C.dim,fontSize:8,fontFamily:"'DM Sans',sans-serif",
      letterSpacing:".08em",textTransform:"uppercase",marginBottom:4}}>{label}</div>
    <div style={{color,fontSize:small?14:17,fontFamily:"'Orbitron',sans-serif",
      fontWeight:700,lineHeight:1}}>{value}</div>
    {sub&&<div style={{color:C.muted,fontSize:8,fontFamily:"'JetBrains Mono',monospace",marginTop:3}}>{sub}</div>}
  </div>
);

const SH=({children,right,sub})=>(
  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12}}>
    <div>
      <div style={{color:C.text,fontSize:11,fontFamily:"'Orbitron',sans-serif",
        fontWeight:700,letterSpacing:".1em",textTransform:"uppercase"}}>{children}</div>
      {sub&&<div style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",marginTop:2}}>{sub}</div>}
    </div>
    {right&&<div style={{flexShrink:0,marginLeft:12}}>{right}</div>}
  </div>
);

const Divider=()=><div style={{height:1,background:C.border,margin:"14px 0"}}/>;

const RulePill=({pass,label})=>(
  <div style={{display:"flex",alignItems:"center",gap:4,padding:"2px 7px",borderRadius:20,
    fontSize:8,background:pass?`${C.green}12`:`${C.red}12`,
    border:`1px solid ${pass?C.green+"30":C.red+"30"}`,
    color:pass?C.green:C.red,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>
    <span>{pass?"✓":"✗"}</span><span>{label}</span>
  </div>
);

const Input=({label,value,onChange,type="text",placeholder,hint})=>(
  <div style={{marginBottom:14}}>
    <div style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",
      fontWeight:600,marginBottom:5,letterSpacing:".05em"}}>{label}</div>
    <input
      type={type} value={value} onChange={e=>onChange(e.target.value)}
      placeholder={placeholder}
      style={{width:"100%",background:C.surface,border:`1px solid ${C.border}`,
        borderRadius:6,color:C.text,fontFamily:"'JetBrains Mono',monospace",
        fontSize:12,padding:"9px 12px",outline:"none",transition:"border-color .15s"}}
      onFocus={e=>e.target.style.borderColor=C.accent}
      onBlur={e=>e.target.style.borderColor=C.border}
    />
    {hint&&<div style={{color:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif",marginTop:4}}>{hint}</div>}
  </div>
);

/* ─── CHART TOOLTIP ──────────────────────────────────────────── */
const ChartTip=({active,payload,label})=>{
  if(!active||!payload?.length) return null;
  const v=payload[0]?.value||0;
  return(
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"7px 10px"}}>
      {label&&<div style={{color:C.dim,fontSize:8,fontFamily:"'JetBrains Mono',monospace",marginBottom:3}}>{label}</div>}
      <div style={{color:payload[0].color||C.accent,fontSize:13,
        fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>{
        typeof v==="number"?(v>100?`$${v.toFixed(2)}`:v.toFixed(3)):v
      }</div>
    </div>
  );
};

const PnlTip=({active,payload})=>{
  if(!active||!payload?.length) return null;
  const v=payload[0]?.value||0;
  return(
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:6,padding:"7px 10px"}}>
      <div style={{color:v>=START_BANKROLL?C.green:C.red,fontSize:13,
        fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>${v.toFixed(2)}</div>
      <div style={{color:C.muted,fontSize:8,fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>
        {fmt$(v-START_BANKROLL)} total P&L
      </div>
    </div>
  );
};

/* ════════════════════════════════════════════════════════════
   SCANNER CARD
════════════════════════════════════════════════════════════ */
const ScanCard=({opp,scoring,onExecute,onSkip,openPositions,bankroll})=>{
  const [age,setAge]=useState(0);
  useEffect(()=>{const t=setInterval(()=>setAge(Date.now()-opp.ts),150);return()=>clearInterval(t);},[opp.ts]);
  const convPct=Math.min(100,(age/opp.convergenceMs)*100);
  const edgeRemain=Math.max(0,opp.edge*(1-convPct/100));
  const sc=scoring; const gm=GRADE_META[sc.grade];
  const isOpen=opp.status==="open"; const isClosed=opp.status==="closed";
  const isSkipped=opp.status==="skipped"; const isDone=isClosed||isSkipped;
  const isExec=opp.status==="auto_exec"||isOpen;

  const statusBadge=isOpen?{color:C.green,label:"● LIVE"}
    :isClosed?{color:C.dim,label:"✓ CLOSED"}
    :isSkipped?{color:C.muted,label:"— SKIPPED"}
    :opp.status==="auto_exec"?{color:C.accent,label:"⚡ AUTO-FIRED"}
    :sc.autoEligible?{color:gm.color,label:gm.label}
    :{color:C.dim,label:"⊘ BELOW THRESHOLD"};

  return(
    <div className={isDone?"fade":"slide"} style={{background:isOpen?`${C.green}06`:isClosed||isSkipped?C.bg:C.card,
      border:`1px solid ${isOpen?C.green+"40":isClosed||isSkipped?C.border:sc.passes?`${gm.color}28`:C.border}`,
      borderLeft:`3px solid ${isOpen?C.green:isClosed||isSkipped?C.muted:sc.passes?gm.color:C.muted}`,
      borderRadius:8,padding:"11px 14px",marginBottom:7,opacity:isDone?.45:1}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
        <div style={{flex:1,minWidth:0,marginRight:12}}>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:5,flexWrap:"wrap"}}>
            <span style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>{opp.market}</span>
            <Badge color={statusBadge.color} tiny>{statusBadge.label}</Badge>
            {opp.polySignal&&<Badge color={C.sky} tiny>📡 Poly signal</Badge>}
          </div>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            <Badge color={opp.strategyColor} tiny>{opp.strategy}</Badge>
            <Badge color={C.teal} tiny>⚡ {opp.platform}</Badge>
            <Badge color={C.dim} tiny>{opp.category}</Badge>
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{color:edgeRemain>=RULES.strongEdge?C.green:edgeRemain>=RULES.minEdge?C.accent:C.amber,
            fontFamily:"'Orbitron',sans-serif",fontSize:16,fontWeight:700,lineHeight:1}}>{fmtP(edgeRemain)}</div>
          <div style={{color:C.dim,fontSize:8,fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>EDGE</div>
          <div style={{color:gm.color,fontSize:9,fontFamily:"'JetBrains Mono',monospace",marginTop:2,fontWeight:700}}>{sc.score}/100</div>
        </div>
      </div>
      <div style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",marginBottom:8,lineHeight:1.5}}>{opp.note}</div>
      <div style={{marginBottom:8}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
          <span style={{color:C.muted,fontSize:8,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif"}}>Spread convergence</span>
          <span style={{color:convPct>75?C.red:convPct>45?C.amber:C.green,fontSize:8,fontFamily:"'JetBrains Mono',monospace"}}>
            {convPct.toFixed(0)}% · {opp.fastConverge?"⚡ fast":"~ slow"}
          </span>
        </div>
        <div style={{height:2,background:`${C.muted}25`,borderRadius:1}}>
          <div style={{height:2,borderRadius:1,width:`${convPct}%`,transition:"width .15s",
            background:`linear-gradient(90deg,${C.green},${convPct>75?C.red:C.amber})`}}/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5,marginBottom:8}}>
        {[["Kelly $",`$${opp.kellySize.toFixed(2)}`],["Fill",fmtP(opp.fillRate)],
          ["Max Profit",`$${opp.maxProfit.toFixed(2)}`],["Liquidity",`$${opp.liquidity.toFixed(0)}`],
          ["Latency",`${opp.execLatencyMs.toFixed(0)}ms`]].map(([l,v])=>(
          <div key={l} style={{background:C.surface,borderRadius:4,padding:"4px 6px"}}>
            <div style={{color:C.muted,fontSize:7,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif"}}>{l}</div>
            <div style={{color:C.text,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>{v}</div>
          </div>
        ))}
      </div>
      {!isDone&&!isExec&&(
        <>
          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:8}}>
            <RulePill pass={opp.edge>=RULES.minEdge} label={`Edge ≥${fmtP(RULES.minEdge)}`}/>
            <RulePill pass={opp.prob>=RULES.minWinProb} label={`Prob ≥${fmtP(RULES.minWinProb)}`}/>
            <RulePill pass={opp.fillRate>=RULES.minFillRate} label={`Fill ≥${fmtP(RULES.minFillRate)}`}/>
            <RulePill pass={opp.liquidity>=RULES.minLiquidity} label={`Liq ≥$${RULES.minLiquidity}`}/>
            <RulePill pass={opp.maxProfit>=RULES.minProfit} label={`Profit ≥$${RULES.minProfit}`}/>
            <RulePill pass={convPct<=RULES.maxConvPct} label={`Conv <${RULES.maxConvPct}%`}/>
          </div>
          {!sc.passes&&sc.failures.length>0&&(
            <div style={{marginBottom:8,padding:"5px 8px",background:`${C.red}0a`,
              border:`1px solid ${C.red}20`,borderRadius:5}}>
              <div style={{color:C.red,fontSize:8,fontFamily:"'JetBrains Mono',monospace",fontWeight:700,marginBottom:2}}>BLOCKED</div>
              {sc.failures.map((f,i)=><div key={i} style={{color:`${C.red}bb`,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>· {f}</div>)}
            </div>
          )}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{color:C.dim,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>
              {sc.passes?sc.autoEligible?"✓ Auto-eligible":"Manual approval needed":`${sc.failures.length} rule${sc.failures.length>1?"s":""} blocking`}
            </div>
            <div style={{display:"flex",gap:6}}>
              <Btn small onClick={()=>onSkip(opp.id)} color={C.muted}>Skip</Btn>
              {sc.passes&&<Btn small onClick={()=>onExecute(opp)} color={C.green} fill>⚡ Execute</Btn>}
            </div>
          </div>
        </>
      )}
      {isOpen&&(
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:6,height:6,borderRadius:3,background:C.green}} className="pulse"/>
          <span style={{color:C.green,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>POSITION OPEN</span>
        </div>
      )}
    </div>
  );
};

/* ─── POSITION CARD ──────────────────────────────────────────── */
const PosCard=({pos,onClose})=>{
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),200);return()=>clearInterval(t);},[]);
  const elapsed=now-pos.openTs;
  const capPct=pos.maxProfit>0?Math.max(0,(pos.currentPnl||0)/pos.maxProfit):0;
  const urgent=elapsed>MAX_HOLD_MS*0.78; const exiting=capPct>=PROFIT_CAPTURE_PCT;
  const pnl=pos.currentPnl||0;
  return(
    <div style={{background:exiting?`${C.green}08`:urgent?`${C.red}06`:C.card,
      border:`1px solid ${exiting?C.green+"50":urgent?C.red+"40":C.borderHi}`,
      borderRadius:8,padding:"12px 14px",marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:9}}>
        <div>
          <div style={{color:C.text,fontSize:13,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:5}}>{pos.market}</div>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            <Badge color={pos.strategyColor} tiny>{pos.strategy}</Badge>
            <Badge color={C.teal} tiny>⚡ {pos.platform}</Badge>
            {exiting&&<Badge color={C.green} tiny>🎯 EXITING</Badge>}
            {urgent&&!exiting&&<Badge color={C.red} tiny>⚠ TIME</Badge>}
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{color:pnl>=0?C.green:C.red,fontFamily:"'Orbitron',sans-serif",fontSize:18,fontWeight:700,lineHeight:1}}>{fmt$(pnl)}</div>
          <div style={{color:C.dim,fontSize:8,fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>{fmtP(Math.abs(pnl/(pos.size||1)))} return</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:10}}>
        {[["Position",`$${pos.size.toFixed(2)}`],["Fill",fmtP(pos.fillRate)],
          ["Open For",ms2s(elapsed)],["Max",`$${pos.maxProfit.toFixed(2)}`]].map(([l,v])=>(
          <div key={l} style={{background:C.surface,borderRadius:5,padding:"5px 8px"}}>
            <div style={{color:C.muted,fontSize:8,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif"}}>{l}</div>
            <div style={{color:C.text,fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>{v}</div>
          </div>
        ))}
      </div>
      {/* Live prices */}
      {pos.entryYes!=null&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:10}}>
          <div style={{background:C.surface,borderRadius:5,padding:"6px 10px",border:`1px solid ${C.border}`}}>
            <div style={{color:C.muted,fontSize:8,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif",marginBottom:3}}>YES Price</div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}>entry <span style={{color:C.text}}>${pos.entryYes.toFixed(3)}</span></span>
              <span style={{color:C.muted,fontSize:9}}>→</span>
              <span style={{color:C.green,fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>${(pos.currentYes??pos.entryYes).toFixed(3)}</span>
              <span style={{color:(pos.currentYes??pos.entryYes)>pos.entryYes?C.green:C.red,fontSize:8,fontFamily:"'JetBrains Mono',monospace"}}>
                {(pos.currentYes??pos.entryYes)>pos.entryYes?"+":""}${((pos.currentYes??pos.entryYes)-pos.entryYes).toFixed(3)}
              </span>
            </div>
          </div>
          <div style={{background:C.surface,borderRadius:5,padding:"6px 10px",border:`1px solid ${C.border}`}}>
            <div style={{color:C.muted,fontSize:8,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif",marginBottom:3}}>NO Price</div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}>entry <span style={{color:C.text}}>${pos.entryNo.toFixed(3)}</span></span>
              <span style={{color:C.muted,fontSize:9}}>→</span>
              <span style={{color:C.green,fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>${(pos.currentNo??pos.entryNo).toFixed(3)}</span>
              <span style={{color:(pos.currentNo??pos.entryNo)>pos.entryNo?C.green:C.red,fontSize:8,fontFamily:"'JetBrains Mono',monospace"}}>
                {(pos.currentNo??pos.entryNo)>pos.entryNo?"+":""}${((pos.currentNo??pos.entryNo)-pos.entryNo).toFixed(3)}
              </span>
            </div>
          </div>
        </div>
      )}
      <div style={{marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
          <span style={{color:C.dim,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>Profit capture — exit at {fmtP(PROFIT_CAPTURE_PCT)}</span>
          <span style={{color:exiting?C.green:urgent?C.red:C.dim,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>
            {exiting?"✓ Auto-exiting":urgent?"⚠ Max hold near":`${fmtP(capPct)} captured`}
          </span>
        </div>
        <div style={{height:4,background:`${C.muted}20`,borderRadius:2,position:"relative"}}>
          <div style={{height:4,borderRadius:2,width:`${Math.min(100,capPct*100)}%`,
            background:exiting?C.green:`linear-gradient(90deg,${C.accent},${C.green})`,transition:"width .3s"}}/>
          <div style={{position:"absolute",top:-2,height:8,width:2,background:C.amber,left:`${PROFIT_CAPTURE_PCT*100}%`}}/>
        </div>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <Btn small onClick={()=>onClose(pos.id)} color={C.amber}>Manual Close</Btn>
      </div>
    </div>
  );
};

/* ─── FEED ITEM ──────────────────────────────────────────────── */
const FeedItem=({item})=>{
  const M={auto_open:{icon:"⚡",label:"AUTO OPEN",color:C.accent},
    manual_open:{icon:"👆",label:"MANUAL OPEN",color:C.accent},
    conv_exit:{icon:"🎯",label:"CONV EXIT",color:C.green},
    force_exit:{icon:"⏰",label:"TIME EXIT",color:C.orange},
    manual_close:{icon:"👆",label:"MANUAL",color:C.dim},
    skip:{icon:"⊘",label:"SKIPPED",color:C.muted}};
  const m=M[item.type]||{icon:"·",label:"EVENT",color:C.dim};
  return(
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",borderBottom:`1px solid ${C.border}15`}}>
      <span style={{fontSize:11,flexShrink:0}}>{m.icon}</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:m.color,fontSize:8,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{m.label}</div>
        <div style={{color:C.dim,fontSize:9,fontFamily:"'DM Sans',sans-serif",
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.market}</div>
      </div>
      {item.profit!==undefined&&(
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{color:item.profit>=0?C.green:C.red,fontSize:11,
            fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>{fmt$(item.profit)}</div>
          {item.holdMs&&<div style={{color:C.muted,fontSize:8,fontFamily:"'JetBrains Mono',monospace"}}>{ms2s(item.holdMs)}</div>}
        </div>
      )}
    </div>
  );
};

/* ════════════════════════════════════════════════════════════
   MAIN APP
════════════════════════════════════════════════════════════ */
export default function ApexPM(){
  /* core */
  const [bankroll,setBankroll]   = useState(START_BANKROLL);
  const [botOn,setBotOn]         = useState(false);
  const [autoExec,setAutoExec]   = useState(true);
  const [autoExit,setAutoExit]   = useState(true);
  const [view,setView]           = useState("dashboard");
  /* data */
  const [opps,setOpps]           = useState([]);
  const [positions,setPositions] = useState([]);
  const [feed,setFeed]           = useState([]);
  const [tradeLog,setTradeLog]   = useState([]);
  const [skippedLog,setSkippedLog]= useState([]); // all skipped opps for review
  const [pnlSeries,setPnlSeries] = useState([{t:"0:00",v:START_BANKROLL,startMs:null}]);
  const [journalNotes,setJournalNotes]=useState({});
  /* strategy */
  const [activeSt,setActiveSt]   = useState(Object.fromEntries(STRATEGIES.map(s=>[s.id,s.id!=="niche"])));
  const [scanFilter,setScanFilter]=useState("all");
  /* api config */
  const [apiSaved,setApiSaved]   = useState(false);
  const [liveMode,setLiveMode]   = useState(false);
  const [liveConfirm,setLiveConfirm]=useState(false); // confirmation step
  const [modePopover,setModePopover]=useState(false); // topbar popover
  const [deployOpen,setDeployOpen]=useState(false);   // settings collapsible
  /* persistence */
  const [lastSaved,setLastSaved] = useState(null);
  const [saveStatus,setSaveStatus]=useState("idle"); // idle | saving | saved | error
  const [restored,setRestored]   = useState(false);
  /* ai review */
  const [reviewPeriod,setReviewPeriod]=useState("weekly");
  const [reviewResult,setReviewResult]=useState(null);
  const [reviewLoading,setReviewLoading]=useState(false);
  const [lastReview,setLastReview]=useState(null);
  const [aiNichePrompt,setAiNichePrompt]=useState("");
  const [aiNicheResult,setAiNicheResult]=useState(null);
  const [aiNicheLoading,setAiNicheLoading]=useState(false);

  /* refs */
  const brRef=useRef(bankroll); const posRef=useRef(positions);
  const autoExecRef=useRef(autoExec); const autoExitRef=useRef(autoExit);
  brRef.current=bankroll; posRef.current=positions;
  autoExecRef.current=autoExec; autoExitRef.current=autoExit;

  /* ── STORAGE SAVE ── */
  const saveState = useCallback(()=>{
    try {
      const snap = {
        bankroll:brRef.current,
        tradeLog, skippedLog, pnlSeries, journalNotes,
        activeSt,
        savedAt: Date.now(),
        version: 4,
      };
      localStorage.setItem("apexpm-session", JSON.stringify(snap));
      setLastSaved(Date.now());
      setSaveStatus("saved");
      setTimeout(()=>setSaveStatus("idle"), 2000);
    } catch(e) { setSaveStatus("error"); setTimeout(()=>setSaveStatus("idle"),3000); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tradeLog, skippedLog, pnlSeries, journalNotes, activeSt, apiSaved]);

  /* ── STORAGE RESTORE on mount ── */
  useEffect(()=>{
    try {
      const raw = localStorage.getItem("apexpm-session");
      if (!raw) return;
      const snap = JSON.parse(raw);
      if (snap.version !== 4) return;
      if (snap.bankroll !== undefined)  setBankroll(snap.bankroll);
      if (snap.tradeLog?.length)        setTradeLog(snap.tradeLog);
      if (snap.skippedLog?.length)      setSkippedLog(snap.skippedLog);
      if (snap.pnlSeries?.length)       setPnlSeries(snap.pnlSeries);
      if (snap.journalNotes)            setJournalNotes(snap.journalNotes);
      if (snap.activeSt)                setActiveSt(snap.activeSt);
      // Credentials are never persisted. Scrub any left by older versions.
      if (snap.kalshiKey || snap.kalshiSecret) {
        delete snap.kalshiKey; delete snap.kalshiSecret;
        localStorage.setItem("apexpm-session", JSON.stringify(snap));
      }
      setLastSaved(snap.savedAt||null);
      setRestored(true);
    } catch(e) { /* fresh session */ }
  },[]);

  /* ── AUTO-SAVE every 30s ── */
  useEffect(()=>{
    const t = setInterval(saveState, 30000);
    return ()=>clearInterval(t);
  },[saveState]);

  /* ── SAVE on page hide (laptop close / tab switch) ── */
  useEffect(()=>{
    const handler = ()=>{ if(document.visibilityState==="hidden") saveState(); };
    document.addEventListener("visibilitychange", handler);
    return ()=>document.removeEventListener("visibilitychange", handler);
  },[saveState]);

  /* ── SAVE on trade log change (after each settled trade) ── */
  useEffect(()=>{
    if (tradeLog.length > 0) saveState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tradeLog.length]);

  /* ── METRICS ── */
  const metrics=useMemo(()=>{
    const wins=tradeLog.filter(t=>t.profit>0).length;
    const rets=tradeLog.map(t=>t.size>0?t.profit/t.size:0);
    const fills=tradeLog.map(t=>t.fillRate||0);
    const avgFill=fills.length?fills.reduce((a,b)=>a+b,0)/fills.length:0;
    const eq=pnlSeries.map(p=>p.v);
    const totalPnl=bankroll-START_BANKROLL;
    const avgWin=tradeLog.filter(t=>t.profit>0).length?tradeLog.filter(t=>t.profit>0).reduce((a,t)=>a+t.profit,0)/tradeLog.filter(t=>t.profit>0).length:0;
    const avgLoss=tradeLog.filter(t=>t.profit<0).length?Math.abs(tradeLog.filter(t=>t.profit<0).reduce((a,t)=>a+t.profit,0)/tradeLog.filter(t=>t.profit<0).length):0;
    return{
      totalPnl, roi:totalPnl/START_BANKROLL,
      winRate:tradeLog.length?wins/tradeLog.length:0,
      trades:tradeLog.length, openPos:positions.length, avgFill,
      sharpe:sharpeR(rets), sortino:sortinoR(rets), mdd:maxDD(eq),
      profitFactor:profitFactor(tradeLog), expectancy:expectancy(tradeLog),
      avgWin, avgLoss, rr:avgLoss>0?avgWin/avgLoss:0,
      autoFired:feed.filter(f=>f.type==="auto_open").length,
      convExits:feed.filter(f=>f.type==="conv_exit").length,
    };
  },[tradeLog,bankroll,pnlSeries,positions,feed]);

  /* ── DAILY P&L DATA for bar chart ── */
  const dailyPnl=useMemo(()=>{
    const byDay={};
    tradeLog.forEach(t=>{
      if(!t.ts) return;
      const d=new Date(t.ts);
      const key=`${d.getMonth()+1}/${d.getDate()}`;
      byDay[key]=(byDay[key]||0)+t.profit;
    });
    return Object.entries(byDay).map(([day,pnl])=>({day,pnl:+pnl.toFixed(2)})).slice(-14);
  },[tradeLog]);

  /* ── STRATEGY P&L breakdown ── */
  const stratBreakdown=useMemo(()=>
    STRATEGIES.map(s=>{
      const logs=tradeLog.filter(t=>t.strategy===s.label);
      const pnl=logs.reduce((a,t)=>a+(t.profit||0),0);
      const wr=logs.length?logs.filter(t=>t.profit>0).length/logs.length:0;
      const avgH=logs.filter(t=>t.holdMs).length?logs.filter(t=>t.holdMs).reduce((a,t)=>a+t.holdMs,0)/logs.filter(t=>t.holdMs).length:0;
      return{...s,logs:logs.length,pnl,wr,avgH,pf:profitFactor(logs),exp:expectancy(logs)};
    })
  ,[tradeLog]);

  /* ── SETTLE ── */
  const settle=useCallback((pos,type,profit)=>{
    const holdMs=Date.now()-pos.openTs;
    const entryTs=pos.openTs;
    setBankroll(b=>{
      const nb=Math.max(0,b+pos.size+profit);
      setPnlSeries(prev=>{
        const startMs=prev[0]?.startMs||Date.now();
        return[...prev.map((p,i)=>i===0?{...p,startMs}:p).slice(-199),
               {t:clock(startMs),v:nb,startMs}];
      });
      return nb;
    });
    // Derive exit prices: spread converges toward 0.50 as edge is captured
    const exitYes = pos.entryYes != null ? Math.min(0.99, pos.entryYes + (pos.edge||0) * 0.6 + (Math.random()-0.5)*0.01) : null;
    const exitNo  = pos.entryNo  != null ? Math.min(0.99, pos.entryNo  + (pos.edge||0) * 0.6 + (Math.random()-0.5)*0.01) : null;
    const entry={id:uid(),ts:entryTs,market:pos.market,strategy:pos.strategy,
      strategyColor:pos.strategyColor,platform:pos.platform,ticker:pos.ticker,
      category:pos.category,size:pos.size,fillRate:pos.fillRate,edge:pos.edge,
      profit,won:profit>0,holdMs,type,
      entryYes:pos.entryYes, entryNo:pos.entryNo,
      exitYes, exitNo};
    setTradeLog(prev=>[entry,...prev].slice(0,500));
    setFeed(prev=>[{...entry},...prev].slice(0,100));
    if(pos.oppId) setOpps(prev=>prev.map(o=>o.id===pos.oppId?{...o,status:"closed"}:o));
  },[]);

  /* ── EXECUTE ── */
  const executeTrade=useCallback((opp,isAuto=false)=>{
    if(posRef.current.length>=MAX_POSITIONS||opp.actualSize>brRef.current*0.95) return;
    setBankroll(b=>b-opp.actualSize);
    const pos={id:uid(),oppId:opp.id,market:opp.market,strategy:opp.strategy,
      strategyColor:opp.strategyColor,platform:opp.platform,ticker:opp.ticker,
      category:opp.category,size:opp.actualSize,fillRate:opp.fillRate,edge:opp.edge,
      prob:opp.prob,maxProfit:opp.maxProfit,openTs:Date.now(),
      convergenceMs:opp.convergenceMs,currentPnl:0,
      entryYes:opp.yesPrice, entryNo:opp.noPrice,
      currentYes:opp.yesPrice, currentNo:opp.noPrice};
    setPositions(prev=>[...prev,pos]);
    setOpps(prev=>prev.map(o=>o.id===opp.id?{...o,status:isAuto?"auto_exec":"open",positionId:pos.id}:o));
    const type=isAuto?"auto_open":"manual_open";
    setFeed(prev=>[{id:uid(),type,market:opp.market,strategy:opp.strategy,
      platform:opp.platform,size:opp.actualSize,fillRate:opp.fillRate,edge:opp.edge,profit:0},
      ...prev].slice(0,100));
    if(!isAuto) setView("positions");
  },[]);

  /* ── CLOSE ── */
  const closePos=useCallback((posId,type="manual_close")=>{
    setPositions(prev=>{
      const pos=prev.find(p=>p.id===posId);
      if(!pos) return prev;
      settle(pos,type,pos.currentPnl||0);
      return prev.filter(p=>p.id!==posId);
    });
  },[settle]);

  /* ── SKIP ── */
  const skipOpp=useCallback((id)=>{
    const opp=opps.find(o=>o.id===id);
    if(opp){
      setSkippedLog(prev=>[{...opp,skippedAt:Date.now()},...prev].slice(0,200));
    }
    setOpps(prev=>prev.map(o=>o.id===id?{...o,status:"skipped"}:o));
    setFeed(prev=>[{id:uid(),type:"skip",market:opp?.market||"",profit:undefined},...prev].slice(0,100));
  },[opps]);

  /* ── SCANNER ── */
  useEffect(()=>{
    if(!botOn) return;
    const interval=setInterval(()=>{
      const enabled=Object.entries(activeSt).filter(([,v])=>v).map(([k])=>k);
      if(!enabled.length) return;
      const sid=enabled[Math.floor(Math.random()*enabled.length)];
      const opp=genOpp(sid,brRef.current);
      if(!opp) return;
      setOpps(prev=>{
        if(autoExecRef.current){
          const sc=scoreOpp(opp,posRef.current.length,brRef.current,0);
          if(sc.autoEligible&&posRef.current.length<MAX_POSITIONS&&opp.actualSize<=brRef.current*0.95){
            setTimeout(()=>executeTrade(opp,true),50+opp.execLatencyMs);
            return[{...opp,status:"auto_exec"},...prev].slice(0,40);
          }
        }
        return[opp,...prev].slice(0,40);
      });
    },2000+Math.random()*3000);
    return()=>clearInterval(interval);
  },[botOn,activeSt,executeTrade]);

  /* ── POSITION P&L + AUTO-EXIT ── */
  useEffect(()=>{
    const interval=setInterval(()=>{
      const now=Date.now();
      setPositions(prev=>{
        const toClose=[];
        const updated=prev.map(pos=>{
          const elapsed=now-pos.openTs;
          const progress=Math.min(1,elapsed/pos.convergenceMs);
          const curve=progress<0.75?(progress/0.75)*pos.maxProfit:pos.maxProfit*(1-(progress-0.75)/0.4*0.1);
          const noise=(Math.random()-0.49)*pos.maxProfit*0.04;
          const currentPnl=Math.max(-pos.size*0.05,curve+noise);
          const capPct=pos.maxProfit>0?currentPnl/pos.maxProfit:0;
          // Live price: YES drifts toward 0.5 as spread converges
          const priceDrift = (pos.edge||0) * progress * 0.8;
          const priceNoise = (Math.random()-0.5)*0.004;
          const currentYes = pos.entryYes!=null ? Math.min(0.98, Math.max(0.02, pos.entryYes + priceDrift + priceNoise)) : null;
          const currentNo  = pos.entryNo !=null ? Math.min(0.98, Math.max(0.02, pos.entryNo  + priceDrift + priceNoise)) : null;
          if(elapsed>=MAX_HOLD_MS||( autoExitRef.current&&capPct>=PROFIT_CAPTURE_PCT)){
            toClose.push({...pos,currentPnl,currentYes,currentNo,exitType:elapsed>=MAX_HOLD_MS?"force_exit":"conv_exit"});
            return null;
          }
          return{...pos,currentPnl,currentYes,currentNo,progress};
        }).filter(Boolean);
        toClose.forEach(p=>settle(p,p.exitType,p.currentPnl));
        return updated;
      });
    },200);
    return()=>clearInterval(interval);
  },[settle]);

  /* ── PNL HEARTBEAT ── */
  useEffect(()=>{
    if(!modePopover) return;
    const handler=(e)=>{
      if(!e.target.closest("[data-modepopover]")) setModePopover(false);
    };
    document.addEventListener("mousedown", handler);
    return()=>document.removeEventListener("mousedown", handler);
  },[modePopover]);

  useEffect(()=>{
    const t=setInterval(()=>{
      setPnlSeries(prev=>{
        const startMs=prev[0]?.startMs||Date.now();
        const nb=brRef.current;
        const last=prev[prev.length-1];
        if(last&&Math.abs(last.v-nb)<0.01&&prev.length>2) return prev;
        return[...prev.map((p,i)=>i===0?{...p,startMs}:p).slice(-199),{t:clock(startMs),v:nb,startMs}];
      });
    },3000);
    return()=>clearInterval(t);
  },[]);

  /* ── SCORED OPPS ── */
  const scoredOpps=useMemo(()=>opps.map(o=>{
    const age=Date.now()-o.ts;
    const convPct=Math.min(100,(age/o.convergenceMs)*100);
    const sc=scoreOpp(o,positions.length,bankroll,convPct);
    return{...o,_sc:sc,_convPct:convPct};
  }),[opps,positions.length,bankroll]);

  const filteredOpps=useMemo(()=>{
    if(scanFilter==="eligible") return scoredOpps.filter(o=>o._sc?.passes&&o.status==="pending");
    if(scanFilter==="open")     return scoredOpps.filter(o=>o.status==="open"||o.status==="auto_exec");
    if(scanFilter==="skipped")  return scoredOpps.filter(o=>o.status==="skipped");
    return scoredOpps;
  },[scoredOpps,scanFilter]);

  const eligibleCount=scoredOpps.filter(o=>o._sc?.passes&&o.status==="pending").length;
  const openCount=scoredOpps.filter(o=>o.status==="open"||o.status==="auto_exec").length;

  /* ── AI REVIEW ── */
  const runReview=async()=>{
    setReviewLoading(true); setReviewResult(null);
    const periodLabel=reviewPeriod==="weekly"?"past 7 days":"past 30 days";
    const cutoff=Date.now()-(reviewPeriod==="weekly"?7:30)*24*3600*1000;
    const periodTrades=tradeLog.filter(t=>t.ts&&t.ts>cutoff);
    const periodSkipped=skippedLog.filter(t=>t.skippedAt&&t.skippedAt>cutoff);
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:1600,
          system:`You are a prediction market trading algorithm analyst. Analyze trading performance data and provide actionable, specific recommendations to improve profitability. Be direct, quantitative, and specific. Return ONLY valid JSON:
{
  "period": "weekly|monthly",
  "summary": "2-3 sentence executive summary",
  "performance": {"assessment":"good|fair|poor","key_metric":"...","trend":"improving|stable|declining"},
  "strategy_insights": [{"strategy":"...","verdict":"keep|tune|drop","reason":"...","suggestion":"..."}],
  "missed_opportunities": {"count":0,"estimated_pnl":"$X","patterns":["..."],"recommendation":"..."},
  "rule_adjustments": [{"rule":"...","current":"...","suggested":"...","rationale":"..."}],
  "risk_observations": ["..."],
  "next_period_focus": ["..."],
  "confidence_score": 0.85
}`,
          messages:[{role:"user",content:`Analyze my ${periodLabel} trading data:

EXECUTED TRADES (${periodTrades.length}):
${periodTrades.slice(0,50).map(t=>`- ${t.market} | ${t.strategy} | Size: $${t.size?.toFixed(2)} | Edge: ${fmtP(t.edge||0)} | Fill: ${fmtP(t.fillRate||0)} | Hold: ${ms2s(t.holdMs||0)} | PnL: ${fmt$(t.profit)} | Exit: ${t.type}`).join("\n")||"None yet"}

SKIPPED OPPORTUNITIES (${periodSkipped.length}):
${periodSkipped.slice(0,30).map(t=>`- ${t.market} | ${t.strategy} | Edge: ${fmtP(t.edge||0)} | Failures: ${t._sc?.failures?.join(", ")||"unknown"}`).join("\n")||"None"}

KEY METRICS:
- Win Rate: ${fmtP(metrics.winRate)} | Trades: ${metrics.trades}
- Total P&L: ${fmt$(metrics.totalPnl)} | ROI: ${fmtP(metrics.roi)}
- Profit Factor: ${metrics.profitFactor.toFixed(2)} | Expectancy: ${fmt$(metrics.expectancy)}
- Sharpe: ${metrics.sharpe.toFixed(2)} | Sortino: ${metrics.sortino.toFixed(2)} | Max DD: ${fmtP(metrics.mdd)}
- Avg Win: ${fmt$(metrics.avgWin)} | Avg Loss: ${fmt$(metrics.avgLoss)} | RR: ${metrics.rr.toFixed(2)}
- Auto-fired: ${metrics.autoFired} | Conv exits: ${metrics.convExits} | Avg fill: ${fmtP(metrics.avgFill)}

CURRENT RULES: minEdge=${fmtP(RULES.minEdge)}, minProb=${fmtP(RULES.minWinProb)}, minFill=${fmtP(RULES.minFillRate)}, minLiq=$${RULES.minLiquidity}, minProfit=$${RULES.minProfit}
ACTIVE STRATEGIES: ${Object.entries(activeSt).filter(([,v])=>v).map(([k])=>k).join(", ")}`}]
        })
      });
      const data=await res.json();
      const text=(data.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("");
      try{setReviewResult(JSON.parse(text.replace(/```json|```/g,"").trim()));}
      catch{setReviewResult({summary:text,strategy_insights:[],missed_opportunities:{},rule_adjustments:[],next_period_focus:[]});}
      setLastReview(Date.now());
    }catch(e){setReviewResult({summary:`Error: ${e.message}`,strategy_insights:[],missed_opportunities:{count:0},rule_adjustments:[],next_period_focus:[]});}
    setReviewLoading(false);
  };

  /* ── AI NICHE FINDER ── */
  const runNiche=async()=>{
    if(!aiNichePrompt.trim()) return;
    setAiNicheLoading(true); setAiNicheResult(null);
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:1200,
          system:`You are a prediction market quant. Find high-edge niches on Kalshi (primary) using Polymarket as a free price oracle. Calculate edge, Kelly sizing, convergence speed. Return ONLY JSON no markdown:
{"niches":[{"market":"...","platform":"Kalshi","poly_oracle":true,"strategy":"YES/NO Arb|Cross-Platform|Logical Corr|Latency Arb|Market Making","edge_pct":4.2,"kelly_pct":8,"win_prob":0.87,"convergence":"Fast (3-8s)|Medium (15-60s)|Slow","reasoning":"...","entry":"...","exit":"...","risks":["..."],"monthly_return":"2-5%"}],"summary":"..."}`,
          messages:[{role:"user",content:aiNichePrompt}]
        })
      });
      const data=await res.json();
      const text=(data.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("");
      try{setAiNicheResult(JSON.parse(text.replace(/```json|```/g,"").trim()));}
      catch{setAiNicheResult({summary:text,niches:[]});}
    }catch(e){setAiNicheResult({summary:`Error: ${e.message}`,niches:[]});}
    setAiNicheLoading(false);
  };

  /* ════════════════════════════════════════════════════════════
     VIEWS
  ════════════════════════════════════════════════════════════ */

  /* ── DASHBOARD ── */
  const vDashboard=(
    <div>
      <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:12}}>
        {[
          {label:"Portfolio",    value:`$${bankroll.toFixed(2)}`,       sub:`Started $${START_BANKROLL}`, color:C.accent},
          {label:"Total P&L",    value:fmt$(metrics.totalPnl),           sub:fmtP(Math.abs(metrics.roi)),  color:metrics.totalPnl>=0?C.green:C.red},
          {label:"Win Rate",     value:fmtP(metrics.winRate),            sub:`${metrics.trades} trades`,   color:C.amber},
          {label:"Expectancy",   value:fmt$(metrics.expectancy),         sub:`PF: ${metrics.profitFactor.toFixed(2)}`, color:metrics.expectancy>0?C.green:C.red},
          {label:"Avg Fill",     value:fmtP(metrics.avgFill),            sub:"Kalshi fill rate",           color:C.purple},
          {label:"Sharpe",       value:isFinite(metrics.sharpe)?metrics.sharpe.toFixed(2):"—",
                                 sub:`MaxDD ${fmtP(metrics.mdd)}`,       color:metrics.sharpe>1?C.green:C.amber},
        ].map(m=><Metric key={m.label} {...m}/>)}
      </div>

      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"11px 15px",marginBottom:12}}>
        <div style={{display:"flex",gap:20,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <Toggle on={autoExec} onChange={v=>{setAutoExec(v);autoExecRef.current=v;}} color={C.green}/>
            <div>
              <div style={{color:autoExec?C.green:C.dim,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>Auto-Execute</div>
              <div style={{color:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>STRONG + GOOD grades only</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <Toggle on={autoExit} onChange={v=>{setAutoExit(v);autoExitRef.current=v;}} color={C.accent}/>
            <div>
              <div style={{color:autoExit?C.accent:C.dim,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>Conv. Exit</div>
              <div style={{color:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>Exit at {fmtP(PROFIT_CAPTURE_PCT)} capture</div>
            </div>
          </div>
          <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
            {!apiSaved&&<Badge color={C.amber} tiny>⚙ Add Kalshi API key in Settings</Badge>}
            {apiSaved&&<Badge color={C.green} tiny>✓ Kalshi API configured</Badge>}
            <Btn onClick={()=>setBotOn(!botOn)} color={botOn?C.red:C.green} fill>{botOn?"⏹ Stop":"▶ Start Bot"}</Btn>
          </div>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 220px",gap:10,marginBottom:12}}>
        {/* Equity curve */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
          <SH sub={liveMode?"Live · Kalshi":"Simulation · Kalshi execution"}>Equity Curve</SH>
          <div style={{height:200}}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={pnlSeries}>
                <defs>
                  <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.accent} stopOpacity={0.22}/>
                    <stop offset="95%" stopColor={C.accent} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 4" stroke={C.border} vertical={false}/>
                <XAxis dataKey="t" tick={{fill:C.muted,fontSize:8,fontFamily:"JetBrains Mono"}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:C.muted,fontSize:8,fontFamily:"JetBrains Mono"}} axisLine={false} tickLine={false} width={50} tickFormatter={v=>`$${v.toFixed(0)}`}/>
                <ReferenceLine y={START_BANKROLL} stroke={C.muted} strokeDasharray="3 3"/>
                <Tooltip content={<PnlTip/>}/>
                <Area type="monotone" dataKey="v" stroke={C.accent} strokeWidth={2} fill="url(#grad)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent trades with in/out prices */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,display:"flex",flexDirection:"column"}}>
          <SH>Recent Trades</SH>
          {tradeLog.length===0
            ? <div style={{color:C.muted,fontSize:11,textAlign:"center",paddingTop:30,fontFamily:"'DM Sans',sans-serif"}}>
                Trades appear here once the bot runs
              </div>
            : <div style={{overflow:"auto",flex:1}}>
                {tradeLog.slice(0,6).map(t=>(
                  <div key={t.id} style={{padding:"8px 0",borderBottom:`1px solid ${C.border}18`}}>
                    {/* Market + result */}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:5}}>
                      <div style={{flex:1,minWidth:0,marginRight:8}}>
                        <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",
                          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.market}</div>
                        <div style={{display:"flex",gap:4,marginTop:2,flexWrap:"wrap"}}>
                          {t.strategyColor&&<Badge color={t.strategyColor} tiny>{t.strategy}</Badge>}
                          <Badge color={t.won?C.green:C.red} tiny>{t.won?"WIN":"LOSS"}</Badge>
                          <Badge color={t.type==="conv_exit"?C.accent:t.type==="force_exit"?C.orange:C.dim} tiny>
                            {t.type==="conv_exit"?"CONV":t.type==="force_exit"?"TIME":"MANUAL"}
                          </Badge>
                        </div>
                      </div>
                      <div style={{color:t.profit>=0?C.green:C.red,fontFamily:"'Orbitron',sans-serif",
                        fontSize:13,fontWeight:700,flexShrink:0}}>{fmt$(t.profit||0)}</div>
                    </div>
                    {/* In / Out prices */}
                    {t.entryYes!=null&&(
                      <div style={{display:"flex",gap:6}}>
                        <div style={{background:C.surface,borderRadius:4,padding:"3px 7px",
                          display:"flex",alignItems:"center",gap:5,flex:1}}>
                          <span style={{color:C.muted,fontSize:8,fontFamily:"'DM Sans',sans-serif",textTransform:"uppercase"}}>YES</span>
                          <span style={{color:C.text,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>${t.entryYes.toFixed(3)}</span>
                          {t.exitYes!=null&&<>
                            <span style={{color:C.muted,fontSize:9}}>→</span>
                            <span style={{color:t.exitYes>t.entryYes?C.green:C.amber,fontSize:10,
                              fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>${t.exitYes.toFixed(3)}</span>
                          </>}
                        </div>
                        <div style={{background:C.surface,borderRadius:4,padding:"3px 7px",
                          display:"flex",alignItems:"center",gap:5,flex:1}}>
                          <span style={{color:C.muted,fontSize:8,fontFamily:"'DM Sans',sans-serif",textTransform:"uppercase"}}>NO</span>
                          <span style={{color:C.text,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>${t.entryNo.toFixed(3)}</span>
                          {t.exitNo!=null&&<>
                            <span style={{color:C.muted,fontSize:9}}>→</span>
                            <span style={{color:t.exitNo>t.entryNo?C.green:C.amber,fontSize:10,
                              fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>${t.exitNo.toFixed(3)}</span>
                          </>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
          }
        </div>

        {/* Execution feed */}
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,display:"flex",flexDirection:"column"}}>
          <SH>Feed</SH>
          <div style={{overflow:"auto",flex:1}}>
            {feed.length===0
              ? <div style={{color:C.muted,fontSize:11,textAlign:"center",paddingTop:30,fontFamily:"'DM Sans',sans-serif"}}>
                  Starts when bot runs
                </div>
              : feed.slice(0,30).map(f=><FeedItem key={f.id} item={f}/>)
            }
          </div>
        </div>
      </div>

      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
        <SH>Strategy Summary</SH>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7}}>
          {stratBreakdown.map(s=>(
            <div key={s.id} style={{background:C.surface,borderRadius:7,padding:"10px 12px",border:`1px solid ${activeSt[s.id]?s.color+"25":C.border}`}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <div style={{width:6,height:6,borderRadius:2,background:s.color}}/>
                <span style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>{s.label}</span>
              </div>
              <div style={{color:C.dim,fontSize:9,fontFamily:"'JetBrains Mono',monospace",marginBottom:3}}>
                {s.logs} trades · {fmtP(s.wr)} WR{s.avgH>0?` · ${ms2s(s.avgH)} avg`:""}
              </div>
              <div style={{color:s.pnl>=0?C.green:C.red,fontSize:14,fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>{fmt$(s.pnl)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  /* ── SCANNER ── */
  const vScanner=(
    <div>
      <SH sub={`${opps.length} total · ${eligibleCount} eligible · ${openCount} live · Kalshi execution`}
        right={<div style={{display:"flex",gap:6,alignItems:"center"}}>
          {botOn&&<div style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:6,height:6,borderRadius:3,background:C.green}} className="pulse"/><span style={{color:C.green,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>LIVE</span></div>}
          <Btn small onClick={()=>setBotOn(!botOn)} color={botOn?C.red:C.green} fill>{botOn?"Stop":"Start"}</Btn>
        </div>}>Market Scanner</SH>
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
        {[{id:"all",label:`All (${opps.length})`},{id:"eligible",label:`Eligible (${eligibleCount})`,color:C.green},
          {id:"open",label:`Live (${openCount})`,color:C.accent},{id:"skipped",label:`Skipped (${scoredOpps.filter(o=>o.status==="skipped").length})`,color:C.muted}]
          .map(f=>(
          <div key={f.id} onClick={()=>setScanFilter(f.id)} style={{cursor:"pointer",padding:"4px 12px",borderRadius:20,fontSize:10,
            fontFamily:"'DM Sans',sans-serif",fontWeight:600,transition:"all .15s",
            background:scanFilter===f.id?`${f.color||C.accent}20`:C.surface,
            border:`1px solid ${scanFilter===f.id?(f.color||C.accent)+"60":C.border}`,
            color:scanFilter===f.id?(f.color||C.accent):C.dim}}>{f.label}</div>
        ))}
      </div>
      {filteredOpps.length===0&&(
        <div style={{textAlign:"center",padding:"50px 20px",color:C.muted}}>
          <div style={{fontSize:28,marginBottom:8}}>📡</div>
          <div style={{fontFamily:"'DM Sans',sans-serif",fontSize:13}}>{botOn?"Scanning Kalshi markets...":"Start the bot to scan"}</div>
          {botOn&&<div style={{width:80,height:2,background:C.accent,margin:"12px auto 0",borderRadius:1}} className="scanline"/>}
        </div>
      )}
      {filteredOpps.map(o=><ScanCard key={o.id} opp={o} scoring={o._sc||{grade:"SKIP",score:0,passes:false,failures:[],autoEligible:false}}
        onExecute={executeTrade} onSkip={skipOpp} openPositions={positions.length} bankroll={bankroll}/>)}
    </div>
  );

  /* ── POSITIONS ── */
  const vPositions=(
    <div>
      <SH sub={`${positions.length} open · $${positions.reduce((a,p)=>a+p.size,0).toFixed(2)} deployed · Kalshi`}
        right={autoExit&&<Badge color={C.accent} tiny>🎯 CONV EXIT ON</Badge>}>Active Positions</SH>
      {autoExit&&positions.length>0&&<div style={{background:`${C.accent}09`,border:`1px solid ${C.accent}25`,
        borderRadius:7,padding:"9px 12px",marginBottom:12,color:C.dim,fontSize:11,
        fontFamily:"'DM Sans',sans-serif",lineHeight:1.6}}>
        Auto-exit at <strong style={{color:C.green}}>{fmtP(PROFIT_CAPTURE_PCT)}</strong> capture or <strong style={{color:C.amber}}>{MAX_HOLD_MS/1000}s</strong> max hold.
      </div>}
      {positions.length===0&&<div style={{textAlign:"center",padding:"50px 20px",color:C.muted,fontFamily:"'DM Sans',sans-serif",fontSize:12}}>
        {botOn?"Bot scanning for opportunities.":"Start the bot to open positions."}</div>}
      {positions.map(p=><PosCard key={p.id} pos={p} onClose={id=>closePos(id,"manual_close")}/>)}
    </div>
  );

  /* ── P&L ANALYTICS ── */
  const vAnalytics=(
    <div>
      <SH sub="Deep performance breakdown · refine your strategy here">P&L Analytics</SH>

      {/* Key stats grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:14}}>
        {[
          {label:"Total P&L",     value:fmt$(metrics.totalPnl),              color:metrics.totalPnl>=0?C.green:C.red},
          {label:"ROI",           value:fmtP(Math.abs(metrics.roi)),          color:metrics.roi>=0?C.green:C.red},
          {label:"Profit Factor", value:metrics.profitFactor>0?(metrics.profitFactor>999?"∞":metrics.profitFactor.toFixed(2)):"—",  color:metrics.profitFactor>=2?C.green:metrics.profitFactor>=1?C.amber:C.red},
          {label:"Expectancy",    value:fmt$(metrics.expectancy),             color:metrics.expectancy>=0?C.green:C.red},
          {label:"Sharpe Ratio",  value:isFinite(metrics.sharpe)?metrics.sharpe.toFixed(2):"—",  color:metrics.sharpe>2?C.green:metrics.sharpe>1?C.amber:C.red},
          {label:"Sortino",       value:isFinite(metrics.sortino)?metrics.sortino.toFixed(2):"—", color:metrics.sortino>2?C.green:metrics.sortino>1?C.amber:C.red},
          {label:"Max Drawdown",  value:fmtP(metrics.mdd),                   color:metrics.mdd<0.05?C.green:metrics.mdd<0.15?C.amber:C.red},
          {label:"Win/Loss R:R",  value:metrics.rr>0?`${metrics.rr.toFixed(2)}:1`:"—",           color:metrics.rr>=2?C.green:metrics.rr>=1?C.amber:C.red},
          {label:"Avg Win",       value:fmt$(metrics.avgWin),                color:C.green},
          {label:"Avg Loss",      value:fmt$(metrics.avgLoss),               color:C.red},
          {label:"Avg Fill Rate", value:fmtP(metrics.avgFill),              color:C.purple},
          {label:"Trades Total",  value:`${metrics.trades}`,                 color:C.accent},
        ].map(m=><Metric key={m.label} {...m} small/>)}
      </div>

      {/* Daily P&L bar chart */}
      {dailyPnl.length>0&&(
        <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:12}}>
          <SH>Daily P&L</SH>
          <div style={{height:160}}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyPnl} barSize={20}>
                <CartesianGrid strokeDasharray="2 4" stroke={C.border} vertical={false}/>
                <XAxis dataKey="day" tick={{fill:C.muted,fontSize:8,fontFamily:"JetBrains Mono"}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fill:C.muted,fontSize:8,fontFamily:"JetBrains Mono"}} axisLine={false} tickLine={false} width={45} tickFormatter={v=>`$${v}`}/>
                <ReferenceLine y={0} stroke={C.border}/>
                <Tooltip content={<ChartTip/>}/>
                <Bar dataKey="pnl" radius={[3,3,0,0]}>
                  {dailyPnl.map((d,i)=><Cell key={i} fill={d.pnl>=0?C.green:C.red}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Strategy deep-dive table */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:12}}>
        <SH>Strategy Deep Dive</SH>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${C.border}`}}>
                {["Strategy","Trades","Win Rate","P&L","Profit Factor","Expectancy","Avg Hold","Status"].map(h=>(
                  <th key={h} style={{color:C.muted,fontFamily:"'DM Sans',sans-serif",fontSize:8,
                    textTransform:"uppercase",letterSpacing:".07em",padding:"5px 9px",textAlign:"left",whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stratBreakdown.map(s=>(
                <tr key={s.id} style={{borderBottom:`1px solid ${C.border}12`}}>
                  <td style={{padding:"8px 9px"}}><div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:6,height:6,borderRadius:2,background:s.color}}/><span style={{color:C.text,fontFamily:"'DM Sans',sans-serif",fontWeight:600}}>{s.label}</span></div></td>
                  <td style={{padding:"8px 9px",color:C.text,fontFamily:"'JetBrains Mono',monospace"}}>{s.logs}</td>
                  <td style={{padding:"8px 9px",color:s.wr>=0.7?C.green:s.wr>=0.5?C.amber:C.red,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>{s.logs?fmtP(s.wr):"—"}</td>
                  <td style={{padding:"8px 9px",color:s.pnl>=0?C.green:C.red,fontFamily:"'Orbitron',sans-serif",fontWeight:700,fontSize:11}}>{fmt$(s.pnl)}</td>
                  <td style={{padding:"8px 9px",color:s.pf>=2?C.green:s.pf>=1?C.amber:C.red,fontFamily:"'JetBrains Mono',monospace"}}>{s.logs?s.pf.toFixed(2):"—"}</td>
                  <td style={{padding:"8px 9px",color:s.exp>=0?C.green:C.red,fontFamily:"'JetBrains Mono',monospace"}}>{s.logs?fmt$(s.exp):"—"}</td>
                  <td style={{padding:"8px 9px",color:C.dim,fontFamily:"'JetBrains Mono',monospace"}}>{s.avgH>0?ms2s(s.avgH):"—"}</td>
                  <td style={{padding:"8px 9px"}}><Badge color={activeSt[s.id]?C.green:C.muted} tiny>{activeSt[s.id]?"Active":"Off"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Category breakdown */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
        <SH>Category Breakdown</SH>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7}}>
          {["Crypto","Macro","Politics","Sports","Corp"].map(cat=>{
            const logs=tradeLog.filter(t=>t.category===cat);
            const pnl=logs.reduce((a,t)=>a+(t.profit||0),0);
            const wr=logs.length?logs.filter(t=>t.profit>0).length/logs.length:0;
            return(
              <div key={cat} style={{background:C.surface,borderRadius:7,padding:"10px 12px",border:`1px solid ${C.border}`}}>
                <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>{cat}</div>
                <div style={{color:C.dim,fontSize:9,fontFamily:"'JetBrains Mono',monospace",marginBottom:3}}>{logs.length} trades · {logs.length?fmtP(wr):"—"}</div>
                <div style={{color:pnl>=0?C.green:C.red,fontSize:13,fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>{logs.length?fmt$(pnl):"—"}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  /* ── TRADE JOURNAL ── */
  const [journalFilter,setJournalFilter]=useState("all");
  const [journalSearch,setJournalSearch]=useState("");
  const [noteEditing,setNoteEditing]=useState(null);
  const [noteDraft,setNoteDraft]=useState("");

  const journalEntries=useMemo(()=>{
    let entries=[
      ...tradeLog.map(t=>({...t,_type:"trade"})),
      ...skippedLog.map(t=>({...t,ts:t.skippedAt,profit:0,_type:"skipped",won:false})),
    ].sort((a,b)=>(b.ts||0)-(a.ts||0));
    if(journalFilter==="wins")    entries=entries.filter(e=>e._type==="trade"&&e.won);
    if(journalFilter==="losses")  entries=entries.filter(e=>e._type==="trade"&&!e.won);
    if(journalFilter==="skipped") entries=entries.filter(e=>e._type==="skipped");
    if(journalSearch) entries=entries.filter(e=>e.market?.toLowerCase().includes(journalSearch.toLowerCase())||e.strategy?.toLowerCase().includes(journalSearch.toLowerCase()));
    return entries.slice(0,200);
  },[tradeLog,skippedLog,journalFilter,journalSearch]);

  const vJournal=(
    <div>
      <SH sub={`${tradeLog.length} trades · ${skippedLog.length} skipped — full history for review`}>Trade Journal</SH>

      {/* Filters */}
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
        {[{id:"all",label:`All (${tradeLog.length+skippedLog.length})`},{id:"wins",label:`Wins (${tradeLog.filter(t=>t.won).length})`,color:C.green},
          {id:"losses",label:`Losses (${tradeLog.filter(t=>!t.won).length})`,color:C.red},
          {id:"skipped",label:`Skipped (${skippedLog.length})`,color:C.muted}]
          .map(f=>(
          <div key={f.id} onClick={()=>setJournalFilter(f.id)} style={{cursor:"pointer",padding:"4px 12px",borderRadius:20,
            fontSize:10,fontFamily:"'DM Sans',sans-serif",fontWeight:600,transition:"all .15s",
            background:journalFilter===f.id?`${f.color||C.accent}20`:C.surface,
            border:`1px solid ${journalFilter===f.id?(f.color||C.accent)+"60":C.border}`,
            color:journalFilter===f.id?(f.color||C.accent):C.dim}}>{f.label}</div>
        ))}
        <input value={journalSearch} onChange={e=>setJournalSearch(e.target.value)}
          placeholder="Search market or strategy..."
          style={{flex:1,minWidth:160,background:C.surface,border:`1px solid ${C.border}`,
            borderRadius:6,color:C.text,fontFamily:"'DM Sans',sans-serif",fontSize:11,
            padding:"5px 10px",outline:"none"}}/>
      </div>

      {journalEntries.length===0&&<div style={{textAlign:"center",padding:"40px 0",color:C.muted,fontFamily:"'DM Sans',sans-serif",fontSize:12}}>No entries yet. Start the bot.</div>}

      {journalEntries.map(entry=>{
        const isSkipped=entry._type==="skipped";
        const note=journalNotes[entry.id]||"";
        const editing=noteEditing===entry.id;
        return(
          <div key={entry.id} style={{background:isSkipped?C.surface:C.card,
            border:`1px solid ${isSkipped?C.border:entry.won?C.green+"25":C.red+"25"}`,
            borderLeft:`3px solid ${isSkipped?C.muted:entry.won?C.green:C.red}`,
            borderRadius:8,padding:"10px 13px",marginBottom:7}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
              <div style={{flex:1,minWidth:0,marginRight:12}}>
                <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>{entry.market||"—"}</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {entry.strategyColor&&<Badge color={entry.strategyColor} tiny>{entry.strategy}</Badge>}
                  {entry.platform&&<Badge color={C.teal} tiny>⚡ {entry.platform}</Badge>}
                  <Badge color={isSkipped?C.muted:entry.won?C.green:C.red} tiny>
                    {isSkipped?"SKIPPED":entry.won?"WIN":"LOSS"}
                  </Badge>
                  {entry.type&&!isSkipped&&<Badge color={entry.type==="conv_exit"?C.accent:entry.type==="force_exit"?C.orange:C.dim} tiny>
                    {entry.type==="conv_exit"?"CONV":entry.type==="force_exit"?"TIME":entry.type==="manual_close"?"MANUAL":"AUTO"}
                  </Badge>}
                  <span style={{color:C.muted,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>{fmtDate(entry.ts)}</span>
                </div>
              </div>
              {!isSkipped&&(
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{color:entry.profit>=0?C.green:C.red,fontFamily:"'Orbitron',sans-serif",fontSize:16,fontWeight:700}}>{fmt$(entry.profit||0)}</div>
                  <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:3}}>
                    <span style={{color:C.dim,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>${entry.size?.toFixed(2)||"—"}</span>
                    <span style={{color:C.dim,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>{fmtP(entry.fillRate||0)} fill</span>
                    {entry.holdMs&&<span style={{color:C.dim,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>{ms2s(entry.holdMs)}</span>}
                  </div>
                </div>
              )}
              {isSkipped&&entry._sc?.failures?.length>0&&(
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{color:C.dim,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>{entry._sc.failures.slice(0,2).join(" · ")}</div>
                </div>
              )}
            </div>
            {/* Price history row */}
            {!isSkipped && entry.entryYes!=null && (
              <div style={{display:"flex",gap:6,marginBottom:6,flexWrap:"wrap"}}>
                <div style={{background:C.surface,borderRadius:5,padding:"4px 9px",
                  border:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:7}}>
                  <span style={{color:C.muted,fontSize:8,fontFamily:"'DM Sans',sans-serif",textTransform:"uppercase",letterSpacing:".05em"}}>YES</span>
                  <span style={{color:C.text,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>${entry.entryYes.toFixed(3)}</span>
                  {entry.exitYes!=null&&<>
                    <span style={{color:C.muted,fontSize:9}}>→</span>
                    <span style={{color:entry.exitYes>entry.entryYes?C.green:C.amber,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>${entry.exitYes.toFixed(3)}</span>
                  </>}
                </div>
                <div style={{background:C.surface,borderRadius:5,padding:"4px 9px",
                  border:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:7}}>
                  <span style={{color:C.muted,fontSize:8,fontFamily:"'DM Sans',sans-serif",textTransform:"uppercase",letterSpacing:".05em"}}>NO</span>
                  <span style={{color:C.text,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>${entry.entryNo.toFixed(3)}</span>
                  {entry.exitNo!=null&&<>
                    <span style={{color:C.muted,fontSize:9}}>→</span>
                    <span style={{color:entry.exitNo>entry.entryNo?C.green:C.amber,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>${entry.exitNo.toFixed(3)}</span>
                  </>}
                </div>
                <div style={{background:C.surface,borderRadius:5,padding:"4px 9px",
                  border:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:5}}>
                  <span style={{color:C.muted,fontSize:8,fontFamily:"'DM Sans',sans-serif",textTransform:"uppercase",letterSpacing:".05em"}}>Edge</span>
                  <span style={{color:C.amber,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>{fmtP(entry.edge||0)}</span>
                </div>
              </div>
            )}
            {/* Notes */}
            <div style={{marginTop:4}}>
              {editing?(
                <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
                  <textarea value={noteDraft} onChange={e=>setNoteDraft(e.target.value)}
                    placeholder="Add trade notes, observations, lessons learned..."
                    style={{flex:1,background:C.surface,border:`1px solid ${C.accent}40`,borderRadius:5,
                      color:C.text,fontFamily:"'DM Sans',sans-serif",fontSize:11,
                      padding:"6px 9px",resize:"vertical",minHeight:50,outline:"none"}}/>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <Btn small onClick={()=>{setJournalNotes(p=>({...p,[entry.id]:noteDraft}));setNoteEditing(null);}} color={C.green} fill>Save</Btn>
                    <Btn small onClick={()=>setNoteEditing(null)} color={C.muted}>Cancel</Btn>
                  </div>
                </div>
              ):(
                <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
                  {note?(
                    <div style={{flex:1,color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",
                      background:C.surface,borderRadius:5,padding:"5px 8px",lineHeight:1.5}}>
                      📝 {note}
                    </div>
                  ):(
                    <div style={{flex:1,color:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif",
                      fontStyle:"italic"}}>No notes yet</div>
                  )}
                  <Btn small onClick={()=>{setNoteEditing(entry.id);setNoteDraft(note);}} color={C.dim}>
                    {note?"Edit":"+ Note"}
                  </Btn>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  /* ── AI REVIEW ── */
  const perf=metrics.profitFactor;
  const vReview=(
    <div>
      <SH sub="Claude analyzes your trades + skipped opportunities and improves your algorithm">AI Performance Review</SH>

      {/* Review trigger */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:14}}>
        <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:12,flexWrap:"wrap"}}>
          {["weekly","monthly"].map(p=>(
            <div key={p} onClick={()=>setReviewPeriod(p)} style={{cursor:"pointer",padding:"5px 14px",borderRadius:20,
              fontSize:11,fontFamily:"'DM Sans',sans-serif",fontWeight:600,transition:"all .15s",
              background:reviewPeriod===p?`${C.pink}20`:C.surface,
              border:`1px solid ${reviewPeriod===p?C.pink+"60":C.border}`,
              color:reviewPeriod===p?C.pink:C.dim}}>
              {p.charAt(0).toUpperCase()+p.slice(1)} Review
            </div>
          ))}
          <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
            {lastReview&&<span style={{color:C.muted,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>Last: {fmtDate(lastReview)}</span>}
            <Btn onClick={runReview} disabled={reviewLoading||metrics.trades===0} color={C.pink} fill>
              {reviewLoading?"🧠 Analyzing...":"🔍 Run Review"}
            </Btn>
          </div>
        </div>
        <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.7}}>
          Claude will analyze your <strong style={{color:C.text}}>{reviewPeriod==="weekly"?"past 7 days":"past 30 days"}</strong> of trades,
          skipped opportunities, win/loss patterns, and current rule thresholds — then provide specific algorithm improvement recommendations.
          {metrics.trades===0&&<span style={{color:C.amber}}> Run the bot first to generate trade data.</span>}
        </div>
      </div>

      {reviewLoading&&(
        <div style={{textAlign:"center",padding:"40px 0"}}>
          <div style={{fontSize:24,marginBottom:8}}>🧠</div>
          <div style={{color:C.pink,fontFamily:"'DM Sans',sans-serif",fontSize:13}}>Claude is reviewing your trading performance...</div>
          <div style={{color:C.muted,fontSize:10,marginTop:5,fontFamily:"'JetBrains Mono',monospace"}}>
            Analyzing {metrics.trades} trades · {skippedLog.length} skipped opportunities
          </div>
        </div>
      )}

      {reviewResult&&(
        <div>
          {/* Summary */}
          <div style={{background:C.card,border:`1px solid ${C.pink}30`,borderRadius:8,padding:14,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{color:C.pink,fontSize:11,fontFamily:"'Orbitron',sans-serif",fontWeight:700,letterSpacing:".1em"}}>REVIEW SUMMARY</div>
              {reviewResult.performance&&(
                <Badge color={reviewResult.performance.assessment==="good"?C.green:reviewResult.performance.assessment==="fair"?C.amber:C.red}>
                  {reviewResult.performance.assessment?.toUpperCase()||"—"} · {reviewResult.performance.trend||"stable"}
                </Badge>
              )}
            </div>
            <div style={{color:C.text,fontSize:12,fontFamily:"'DM Sans',sans-serif",lineHeight:1.7}}>{reviewResult.summary}</div>
            {reviewResult.performance?.key_metric&&(
              <div style={{marginTop:8,color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}>Key metric: {reviewResult.performance.key_metric}</div>
            )}
          </div>

          {/* Strategy insights */}
          {reviewResult.strategy_insights?.length>0&&(
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:12}}>
              <SH>Strategy Insights</SH>
              {reviewResult.strategy_insights.map((s,i)=>(
                <div key={i} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:`1px solid ${C.border}18`}}>
                  <Badge color={s.verdict==="keep"?C.green:s.verdict==="tune"?C.amber:C.red}>{s.verdict?.toUpperCase()||"—"}</Badge>
                  <div style={{flex:1}}>
                    <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:2}}>{s.strategy}</div>
                    <div style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",lineHeight:1.5}}>{s.reason}</div>
                    {s.suggestion&&<div style={{color:C.accent,fontSize:10,fontFamily:"'DM Sans',sans-serif",marginTop:3}}>→ {s.suggestion}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Missed opportunities */}
          {reviewResult.missed_opportunities&&(
            <div style={{background:C.card,border:`1px solid ${C.amber}25`,borderRadius:8,padding:14,marginBottom:12}}>
              <SH>Missed Opportunities</SH>
              <div style={{display:"flex",gap:12,marginBottom:10}}>
                <div style={{background:C.surface,borderRadius:6,padding:"8px 12px",flex:1}}>
                  <div style={{color:C.muted,fontSize:8,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif",marginBottom:3}}>Skipped Count</div>
                  <div style={{color:C.amber,fontSize:16,fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>{reviewResult.missed_opportunities.count||skippedLog.length}</div>
                </div>
                <div style={{background:C.surface,borderRadius:6,padding:"8px 12px",flex:1}}>
                  <div style={{color:C.muted,fontSize:8,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif",marginBottom:3}}>Est. P&L Missed</div>
                  <div style={{color:C.red,fontSize:16,fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>{reviewResult.missed_opportunities.estimated_pnl||"—"}</div>
                </div>
              </div>
              {reviewResult.missed_opportunities.patterns?.map((p,i)=>(
                <div key={i} style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",lineHeight:1.5,marginBottom:3}}>· {p}</div>
              ))}
              {reviewResult.missed_opportunities.recommendation&&(
                <div style={{marginTop:8,padding:"8px 10px",background:`${C.amber}10`,border:`1px solid ${C.amber}25`,borderRadius:5,
                  color:C.amber,fontSize:11,fontFamily:"'DM Sans',sans-serif"}}>
                  ⚡ {reviewResult.missed_opportunities.recommendation}
                </div>
              )}
            </div>
          )}

          {/* Rule adjustments */}
          {reviewResult.rule_adjustments?.length>0&&(
            <div style={{background:C.card,border:`1px solid ${C.accent}25`,borderRadius:8,padding:14,marginBottom:12}}>
              <SH>Recommended Rule Adjustments</SH>
              {reviewResult.rule_adjustments.map((r,i)=>(
                <div key={i} style={{padding:"8px 0",borderBottom:`1px solid ${C.border}18`}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:3,flexWrap:"wrap"}}>
                    <span style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>{r.rule}</span>
                    <Badge color={C.muted} tiny>{r.current}</Badge>
                    <span style={{color:C.dim,fontSize:9}}>→</span>
                    <Badge color={C.accent} tiny>{r.suggested}</Badge>
                  </div>
                  <div style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",lineHeight:1.5}}>{r.rationale}</div>
                </div>
              ))}
            </div>
          )}

          {/* Next period focus */}
          {reviewResult.next_period_focus?.length>0&&(
            <div style={{background:C.card,border:`1px solid ${C.green}25`,borderRadius:8,padding:14}}>
              <SH>Next Period Focus</SH>
              {reviewResult.next_period_focus.map((f,i)=>(
                <div key={i} style={{color:C.text,fontSize:11,fontFamily:"'DM Sans',sans-serif",
                  lineHeight:1.7,padding:"4px 0",borderBottom:`1px solid ${C.border}12`}}>
                  {i+1}. {f}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Divider/>

      {/* AI Niche Finder */}
      <SH sub="Claude identifies untapped Kalshi markets with mathematical edge">AI Niche Finder</SH>
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:14}}>
        <textarea value={aiNichePrompt} onChange={e=>setAiNichePrompt(e.target.value)}
          placeholder="e.g. Find YES/NO arb on Kalshi crypto short-duration markets... or identify Kalshi political markets where Polymarket shows a large divergence..."
          style={{width:"100%",minHeight:72,background:C.surface,border:`1px solid ${C.border}`,
            borderRadius:6,color:C.text,fontFamily:"'DM Sans',sans-serif",fontSize:12,
            padding:"9px 12px",resize:"vertical",outline:"none",marginBottom:10}}/>
        <Btn onClick={runNiche} disabled={aiNicheLoading||!aiNichePrompt.trim()} color={C.pink} fill>
          {aiNicheLoading?"🧠 Analyzing...":"🔍 Find Kalshi Niches"}
        </Btn>
      </div>
      {aiNicheResult&&(
        <div>
          {aiNicheResult.summary&&<div style={{background:C.card,border:`1px solid ${C.pink}30`,borderRadius:8,
            padding:12,marginBottom:12,color:C.text,fontSize:12,
            fontFamily:"'DM Sans',sans-serif",lineHeight:1.7}}>
            <strong style={{color:C.pink}}>Analysis: </strong>{aiNicheResult.summary}
          </div>}
          {(aiNicheResult.niches||[]).map((n,i)=>(
            <div key={i} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${C.pink}`,
              borderRadius:8,padding:13,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                <div>
                  <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>{n.market}</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    <Badge color={C.pink} tiny>{n.strategy}</Badge>
                    <Badge color={C.teal} tiny>⚡ {n.platform}</Badge>
                    {n.poly_oracle&&<Badge color={C.sky} tiny>📡 Poly oracle</Badge>}
                    <Badge color={n.convergence?.startsWith("Fast")?C.green:C.amber} tiny>{n.convergence}</Badge>
                  </div>
                </div>
                <div style={{textAlign:"right",marginLeft:10,flexShrink:0}}>
                  <div style={{color:C.green,fontSize:18,fontFamily:"'Orbitron',sans-serif",fontWeight:700}}>{n.edge_pct}%</div>
                  <div style={{color:C.muted,fontSize:8,fontFamily:"'JetBrains Mono',monospace"}}>EDGE</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:10}}>
                {[["Kelly %",`${n.kelly_pct||"—"}%`],["Win Prob",`${((n.win_prob||0)*100).toFixed(0)}%`],["Monthly",n.monthly_return||"N/A"]].map(([l,v])=>(
                  <div key={l} style={{background:C.surface,borderRadius:5,padding:"5px 8px"}}>
                    <div style={{color:C.muted,fontSize:8,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif"}}>{l}</div>
                    <div style={{color:C.text,fontSize:11,fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.6,marginBottom:5}}>
                <strong style={{color:C.text}}>Why: </strong>{n.reasoning}</div>
              {n.entry&&<div style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",marginBottom:2}}>
                <span style={{color:C.green}}>ENTRY: </span>{n.entry}</div>}
              {n.exit&&<div style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",marginBottom:8}}>
                <span style={{color:C.amber}}>EXIT: </span>{n.exit}</div>}
              {n.risks?.length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {n.risks.map((r,j)=><Badge key={j} color={C.amber} tiny>⚠ {r}</Badge>)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /* ── STRATEGIES ── */
  const vStrategies=(
    <div>
      <SH sub="Configure which strategies run and view their execution profile">Strategy Configuration</SH>
      <div style={{background:C.card,border:`1px solid ${C.teal}25`,borderRadius:8,padding:"11px 14px",marginBottom:14,
        fontSize:11,color:C.dim,fontFamily:"'DM Sans',sans-serif",lineHeight:1.8}}>
        <strong style={{color:C.teal}}>Execution: Kalshi only.</strong> Cross-Platform strategy reads Polymarket prices via their open API (no account needed) then executes on Kalshi. All other strategies are native Kalshi.
        <br/><strong style={{color:C.accent}}>Kelly:</strong> f* = (p·b − q) / b at {KELLY_FRACTION*100}% fractional, max {MAX_POS_PCT*100}% per position.
      </div>
      {STRATEGIES.map(s=>(
        <div key={s.id} style={{background:C.card,border:`1px solid ${activeSt[s.id]?s.color+"35":C.border}`,
          borderRadius:8,padding:"12px 14px",marginBottom:8,transition:"border-color .2s"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <Toggle on={activeSt[s.id]} onChange={v=>setActiveSt(p=>({...p,[s.id]:v}))} color={s.color}/>
              <div>
                <div style={{color:activeSt[s.id]?C.text:C.dim,fontSize:13,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>{s.label}</div>
                <div style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",marginTop:1}}>{s.desc}</div>
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <Badge color={s.color}>{s.risk}</Badge>
              <div style={{color:C.dim,fontSize:9,fontFamily:"'JetBrains Mono',monospace",marginTop:3}}>{fmtP(s.baseWR)} base WR</div>
              <div style={{color:s.fastConverge?C.green:C.amber,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>
                {s.fastConverge?"⚡ fast":"~ slow"} · <span style={{color:C.teal}}>{s.exec}</span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  /* ── SETTINGS ── */
  const vSettings=(
    <div>
      <SH sub="Configure your Kalshi API credentials to enable live trading">Settings & API Configuration</SH>

      {/* Kalshi banner */}
      <div style={{background:`${C.teal}10`,border:`1px solid ${C.teal}30`,borderRadius:8,padding:"12px 14px",marginBottom:16}}>
        <div style={{color:C.teal,fontSize:12,fontWeight:700,fontFamily:"'DM Sans',sans-serif",marginBottom:6}}>
          ⚡ Kalshi — Primary Execution Exchange
        </div>
        <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.7}}>
          All trades execute on Kalshi's CFTC-regulated exchange. Cross-Platform strategy reads Polymarket's
          open API for price signals at no cost — no Polymarket account required.
        </div>
        <div style={{marginTop:8,display:"flex",gap:8,flexWrap:"wrap"}}>
          <Badge color={C.teal} tiny>✓ CFTC Regulated</Badge>
          <Badge color={C.teal} tiny>✓ USD Settlement</Badge>
          <Badge color={C.sky} tiny>📡 Polymarket API (price oracle, no account needed)</Badge>
        </div>
      </div>

      {/* API Key form */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:16,marginBottom:16}}>
        <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:12}}>Kalshi API Credentials</div>
        {/* SECURITY: no credential inputs in the browser. Keys live only in the bot's host env vars. */}
        <div style={{color:C.dim,fontSize:12,lineHeight:1.6,marginBottom:12}}>
          Kalshi keys are set <b>only</b> in the bot's server environment (e.g. Render/Railway variables),
          never typed into this page.
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <Btn onClick={()=>setApiSaved(v=>!v)} color={C.teal} fill={!apiSaved}>
            {apiSaved ? "Unmark" : "I've set my keys on the server"}
          </Btn>
          {apiSaved&&<Badge color={C.green}>✓ Marked as configured</Badge>}
        </div>
      </div>

      {/* How to get API key */}
      <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:14}}>
        <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:10}}>How to Get Your Kalshi API Key</div>
        {[
          {step:"1",text:"Log in to kalshi.com and go to Settings (top right avatar menu)"},
          {step:"2",text:"Click 'API Keys' in the left sidebar"},
          {step:"3",text:"Click 'Create New Key' — give it a name like 'ApexPM Bot'"},
          {step:"4",text:"Set permissions: Read + Trade (both required for live execution)"},
          {step:"5",text:"Copy your Key ID and download the private key file"},
          {step:"6",text:"Add them to the bot server's environment variables (never paste keys into this page)"},
        ].map(s=>(
          <div key={s.step} style={{display:"flex",gap:10,padding:"7px 0",borderBottom:`1px solid ${C.border}18`}}>
            <div style={{width:20,height:20,borderRadius:10,background:`${C.teal}20`,color:C.teal,
              fontSize:10,fontFamily:"'Orbitron',sans-serif",fontWeight:700,flexShrink:0,
              display:"flex",alignItems:"center",justifyContent:"center"}}>{s.step}</div>
            <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.5}}>{s.text}</div>
          </div>
        ))}
      </div>

      {/* Live / Simulation Mode Toggle */}
      <div style={{
        background: liveMode ? `${C.red}0d` : `${C.amber}0a`,
        border:`1px solid ${liveMode ? C.red+"40" : C.amber+"25"}`,
        borderRadius:8, padding:"14px 16px",
      }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:10}}>
          <div>
            <div style={{color:liveMode?C.red:C.amber,fontSize:13,fontWeight:700,
              fontFamily:"'Orbitron',sans-serif",letterSpacing:".06em",marginBottom:4}}>
              {liveMode ? "🔴 LIVE TRADING MODE" : "🟡 SIMULATION MODE"}
            </div>
            <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.6}}>
              {liveMode
                ? "Real orders are being placed on your Kalshi account. Real money at risk."
                : "All trades are simulated. No real orders are placed. Safe to run indefinitely."}
            </div>
          </div>
          <Toggle on={liveMode} onChange={v=>{
            if(v && !apiSaved){ alert("Load your Kalshi API credentials above before enabling live trading."); return; }
            if(v){ setLiveConfirm(true); } else { setLiveMode(false); }
          }} color={C.red}/>
        </div>

        {/* Confirmation step */}
        {liveConfirm && !liveMode && (
          <div style={{background:`${C.red}10`,border:`1px solid ${C.red}30`,
            borderRadius:7,padding:"12px 14px",marginTop:4}}>
            <div style={{color:C.red,fontSize:12,fontWeight:700,fontFamily:"'DM Sans',sans-serif",marginBottom:6}}>
              ⚠ Confirm: Switch to Live Trading
            </div>
            <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.7,marginBottom:10}}>
              This will connect the bot to your real Kalshi account using the API credentials above.
              All executed trades will place <strong style={{color:C.text}}>real orders</strong> and
              use <strong style={{color:C.text}}>real funds</strong>. Start with a small bankroll
              until you've validated live performance matches simulation.
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn onClick={()=>{ setLiveMode(true); setLiveConfirm(false); setBotOn(false); }}
                color={C.red} fill>Yes, go live</Btn>
              <Btn onClick={()=>setLiveConfirm(false)} color={C.muted}>Cancel</Btn>
            </div>
          </div>
        )}

        {/* Checklist shown before going live */}
        {!liveMode && !liveConfirm && (
          <div style={{marginTop:4}}>
            <div style={{color:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif",
              textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Pre-live checklist</div>
            {[
              {done:tradeLog.length>=50,  label:`${tradeLog.length}/50+ simulation trades run`},
              {done:metrics.winRate>=0.6, label:`Win rate ≥ 60% (current: ${tradeLog.length?fmtP(metrics.winRate):"—"})`},
              {done:metrics.profitFactor>=1.3, label:`Profit factor ≥ 1.3 (current: ${tradeLog.length?metrics.profitFactor.toFixed(2):"—"})`},
              {done:metrics.mdd<0.15,    label:`Max drawdown < 15% (current: ${fmtP(metrics.mdd)})`},
              {done:apiSaved,            label:"Kalshi API credentials loaded"},
            ].map((item,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:7,padding:"3px 0"}}>
                <span style={{color:item.done?C.green:C.muted,fontSize:12}}>{item.done?"✓":"○"}</span>
                <span style={{color:item.done?C.dim:C.muted,fontSize:10,
                  fontFamily:"'DM Sans',sans-serif",
                  textDecoration:item.done?"line-through":"none"}}>{item.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Deployment Guide (collapsible) */}
      <div style={{marginTop:16}}>
        <div onClick={()=>setDeployOpen(o=>!o)} style={{
          display:"flex",alignItems:"center",justifyContent:"space-between",
          background:C.card,border:`1px solid ${C.border}`,borderRadius:8,
          padding:"11px 14px",cursor:"pointer",userSelect:"none",
        }}>
          <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif"}}>
            🚀 Deployment & Go-Live Guide
          </div>
          <span style={{color:C.dim,fontSize:11}}>{deployOpen?"▲":"▼"}</span>
        </div>
        {deployOpen&&(
          <div style={{border:`1px solid ${C.border}`,borderTop:"none",borderRadius:"0 0 8px 8px",
            padding:14,background:C.card}}>
            {vDeploy}
          </div>
        )}
      </div>
    </div>
  );

  /* ── DEPLOY VIEW ── */
  const CODE_PY = `# apexpm_bot.py — runs 24/7 on your VPS
# pip install kalshi-python requests schedule python-dotenv

import os, time, schedule, requests
from dotenv import load_dotenv
from kalshi_python.api import KalshiApi

load_dotenv()

API_KEY    = os.getenv("KALSHI_API_KEY")
API_SECRET = os.getenv("KALSHI_API_SECRET")
BANKROLL   = float(os.getenv("BANKROLL", "500"))

MIN_EDGE      = 0.025
MIN_WIN_PROB  = 0.75
KELLY_FRAC    = 0.25
MAX_POS_PCT   = 0.12

client = KalshiApi(key_id=API_KEY, private_key=API_SECRET)

def get_polymarket_price(ticker):
    """Free price oracle — no account needed"""
    try:
        r = requests.get(
            f"https://clob.polymarket.com/markets/{ticker}",
            timeout=3)
        data = r.json()
        return float(data.get("last_trade_price", 0.5))
    except:
        return None

def kelly_size(edge, prob, bankroll):
    b = max(0.1, 1/(1-edge+0.01) - 1)
    fk = max(0, (prob*b - (1-prob))/b) * KELLY_FRAC
    return min(fk * bankroll, MAX_POS_PCT * bankroll)

def scan_yes_no_arb():
    """Scan Kalshi for YES+NO < $1 opportunities"""
    try:
        markets = client.get_markets(status="open").markets
        for m in markets:
            yes = float(m.yes_ask or 0)
            no  = float(m.no_ask  or 0)
            edge = 1 - yes - no
            if edge >= MIN_EDGE:
                size = kelly_size(edge, 0.97, BANKROLL)
                print(f"[ARB] {m.ticker}: YES={yes:.3f} NO={no:.3f} edge={edge:.3f} size=\${size:.2f}")
                # execute: client.create_order(ticker=m.ticker, ...)
    except Exception as e:
        print(f"scan error: {e}")

def run():
    scan_yes_no_arb()
    # add more strategies here

schedule.every(30).seconds.do(run)

print("ApexPM bot started. Ctrl+C to stop.")
while True:
    schedule.run_pending()
    time.sleep(1)`;

  const CODE_ENV = `# .env — never commit this file
KALSHI_API_KEY=your-key-id-here
KALSHI_API_SECRET=your-private-key-here
BANKROLL=500`;

  const CODE_SERVICE = `# /etc/systemd/system/apexpm.service
# sudo systemctl enable apexpm && sudo systemctl start apexpm

[Unit]
Description=ApexPM Trading Bot
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/apexpm
ExecStart=/usr/bin/python3 /home/ubuntu/apexpm/apexpm_bot.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target`;

  const [deployTab, setDeployTab] = useState("overview");

  const vDeploy = (
    <div>
      <SH sub="How to run ApexPM 24/7 — simulation and live trading architecture">Deployment Guide</SH>

      {/* Persistence status */}
      <div style={{background:`${C.green}0a`,border:`1px solid ${C.green}25`,borderRadius:8,
        padding:"11px 14px",marginBottom:14,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{fontSize:20}}>💾</div>
        <div style={{flex:1}}>
          <div style={{color:C.green,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:2}}>
            Session Auto-Save Active
          </div>
          <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.5}}>
            State saves every 30 seconds and instantly when you close or switch tabs.
            Close your laptop — when you come back and reopen this tab, everything resumes exactly where you left off.
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          {lastSaved
            ? <Badge color={C.green}>✓ Saved {fmtDate(lastSaved)}</Badge>
            : <Badge color={C.amber} tiny>Not loaded</Badge>}
          <div style={{marginTop:6}}>
            <Btn small onClick={saveState} color={C.green}>Save Now</Btn>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        {[
          {id:"overview",  label:"How It Works"},
          {id:"vps",       label:"VPS Setup"},
          {id:"code",      label:"Bot Code"},
          {id:"systemd",   label:"Keep-Alive"},
          {id:"arch",      label:"Architecture"},
        ].map(t=>(
          <div key={t.id} onClick={()=>setDeployTab(t.id)} style={{
            cursor:"pointer",padding:"5px 14px",borderRadius:20,fontSize:11,
            fontFamily:"'DM Sans',sans-serif",fontWeight:600,transition:"all .15s",
            background:deployTab===t.id?`${C.accent}20`:C.card,
            border:`1px solid ${deployTab===t.id?C.accent+"50":C.border}`,
            color:deployTab===t.id?C.accent:C.dim,
          }}>{t.label}</div>
        ))}
      </div>

      {/* OVERVIEW */}
      {deployTab==="overview"&&(
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <div style={{background:C.card,border:`1px solid ${C.amber}25`,borderRadius:8,padding:14}}>
              <div style={{color:C.amber,fontSize:11,fontWeight:700,fontFamily:"'Orbitron',sans-serif",letterSpacing:".08em",marginBottom:8}}>
                🖥 THIS APP (Browser)
              </div>
              {["Dashboard · monitor P&L and positions","Scanner · review opportunities manually","Trade Journal · log notes and review","AI Review · weekly/monthly analysis","Settings · configure API keys","State persists across sessions via storage"].map((l,i)=>(
                <div key={i} style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",
                  padding:"4px 0",borderBottom:`1px solid ${C.border}18`,lineHeight:1.5}}>✓ {l}</div>
              ))}
              <div style={{marginTop:10,color:C.amber,fontSize:10,fontFamily:"'DM Sans',sans-serif",lineHeight:1.6}}>
                ⚠ <strong>Cannot run 24/7.</strong> JavaScript pauses when laptop sleeps or tab is hidden. Use the browser as your control panel only.
              </div>
            </div>
            <div style={{background:C.card,border:`1px solid ${C.green}25`,borderRadius:8,padding:14}}>
              <div style={{color:C.green,fontSize:11,fontWeight:700,fontFamily:"'Orbitron',sans-serif",letterSpacing:".08em",marginBottom:8}}>
                ⚡ BACKEND SERVER (24/7)
              </div>
              {["Runs Python bot script continuously","Hits Kalshi API directly via REST","Scans markets every 30 seconds","Executes orders on your Kalshi account","Reads Polymarket as free price oracle","Logs to file / sends alerts to you"].map((l,i)=>(
                <div key={i} style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",
                  padding:"4px 0",borderBottom:`1px solid ${C.border}18`,lineHeight:1.5}}>✓ {l}</div>
              ))}
              <div style={{marginTop:10,color:C.green,fontSize:10,fontFamily:"'DM Sans',sans-serif",lineHeight:1.6}}>
                ✓ <strong>Runs indefinitely.</strong> $6/mo VPS handles this easily. You check the browser dashboard whenever you want.
              </div>
            </div>
          </div>

          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
            <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:10}}>Right Now: Simulation Mode</div>
            <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.8}}>
              You're in simulation. Run it as long as you want — state saves automatically so closing your laptop is fine.
              Build up 200–500 trades of history, review the AI analysis, tune the rules, get confident in the strategy.
              When ready: spin up a $6 VPS, deploy the Python script (see Bot Code tab), add your Kalshi API key, done.
            </div>
            <div style={{marginTop:12,display:"flex",gap:8,flexWrap:"wrap"}}>
              <Badge color={C.amber} tiny>Phase 1: Simulation (now)</Badge>
              <span style={{color:C.muted,fontSize:10}}>→</span>
              <Badge color={C.accent} tiny>Phase 2: Paper trade live data</Badge>
              <span style={{color:C.muted,fontSize:10}}>→</span>
              <Badge color={C.green} tiny>Phase 3: Live with small size</Badge>
              <span style={{color:C.muted,fontSize:10}}>→</span>
              <Badge color={C.green} tiny>Phase 4: Scale up</Badge>
            </div>
          </div>
        </div>
      )}

      {/* VPS SETUP */}
      {deployTab==="vps"&&(
        <div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:12}}>
            <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:10}}>Recommended: DigitalOcean Droplet (~$6/mo)</div>
            {[
              {step:"1", title:"Create a Droplet", desc:"digitalocean.com → Create → Droplet. Choose Ubuntu 22.04, Basic plan, $6/mo (1GB RAM, 1 vCPU). Pick any datacenter region."},
              {step:"2", title:"SSH in", desc:'Open terminal: ssh root@YOUR_DROPLET_IP\nThen create a user: adduser apexpm && usermod -aG sudo apexpm'},
              {step:"3", title:"Install Python", desc:"apt update && apt install -y python3 python3-pip python3-venv\npip3 install kalshi-python requests schedule python-dotenv"},
              {step:"4", title:"Upload your bot", desc:"scp apexpm_bot.py apexpm@YOUR_IP:~/apexpm/\nscp .env apexpm@YOUR_IP:~/apexpm/\nOr use git clone if you push to a private repo."},
              {step:"5", title:"Test it", desc:"cd ~/apexpm && python3 apexpm_bot.py\nYou should see 'ApexPM bot started' and scan results every 30s."},
              {step:"6", title:"Install as service", desc:"Copy the systemd config (see Keep-Alive tab). This makes the bot restart automatically on crash or reboot."},
            ].map(s=>(
              <div key={s.step} style={{display:"flex",gap:12,padding:"10px 0",borderBottom:`1px solid ${C.border}18`}}>
                <div style={{width:24,height:24,borderRadius:12,background:`${C.accent}18`,color:C.accent,
                  fontSize:10,fontFamily:"'Orbitron',sans-serif",fontWeight:700,flexShrink:0,
                  display:"flex",alignItems:"center",justifyContent:"center"}}>{s.step}</div>
                <div>
                  <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:3}}>{s.title}</div>
                  <div style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{background:`${C.teal}0a`,border:`1px solid ${C.teal}25`,borderRadius:8,padding:12}}>
            <div style={{color:C.teal,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>Alternatives</div>
            <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.7}}>
              <strong style={{color:C.text}}>Railway.app</strong> — deploy from GitHub, $5/mo, zero server management.<br/>
              <strong style={{color:C.text}}>Render.com</strong> — free tier available (spins down after inactivity — not ideal for trading).<br/>
              <strong style={{color:C.text}}>Fly.io</strong> — generous free tier, great for lightweight Python scripts.<br/>
              <strong style={{color:C.text}}>AWS EC2 t3.micro</strong> — free for 12 months on new accounts.
            </div>
          </div>
        </div>
      )}

      {/* BOT CODE */}
      {deployTab==="code"&&(
        <div>
          <div style={{marginBottom:12}}>
            <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>apexpm_bot.py</div>
            <div style={{background:"#050510",border:`1px solid ${C.border}`,borderRadius:7,padding:14,overflowX:"auto"}}>
              <pre style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.7,margin:0,whiteSpace:"pre"}}>
                {CODE_PY}
              </pre>
            </div>
          </div>
          <div style={{marginBottom:12}}>
            <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>.env (never commit)</div>
            <div style={{background:"#050510",border:`1px solid ${C.border}`,borderRadius:7,padding:14}}>
              <pre style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.7,margin:0}}>
                {CODE_ENV}
              </pre>
            </div>
          </div>
          <div style={{background:`${C.amber}0a`,border:`1px solid ${C.amber}25`,borderRadius:8,padding:12}}>
            <div style={{color:C.amber,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>Important</div>
            <div style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",lineHeight:1.7}}>
              The script above is the skeleton — same logic as the simulation. Once you're happy with simulation results, we'll expand it with all 6 strategies, risk limits, Telegram alerts, and order management. Start with YES/NO Arb only until you're confident.
            </div>
          </div>
        </div>
      )}

      {/* SYSTEMD */}
      {deployTab==="systemd"&&(
        <div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:12}}>
            <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>
              systemd service — auto-restart on crash or reboot
            </div>
            <div style={{background:"#050510",border:`1px solid ${C.border}`,borderRadius:7,padding:14,overflowX:"auto",marginBottom:12}}>
              <pre style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.7,margin:0}}>
                {CODE_SERVICE}
              </pre>
            </div>
            {[
              {cmd:"sudo systemctl enable apexpm",   desc:"Start on reboot"},
              {cmd:"sudo systemctl start apexpm",    desc:"Start now"},
              {cmd:"sudo systemctl status apexpm",   desc:"Check it's running"},
              {cmd:"sudo journalctl -u apexpm -f",   desc:"Live log tail"},
              {cmd:"sudo systemctl restart apexpm",  desc:"Restart after code change"},
              {cmd:"sudo systemctl stop apexpm",     desc:"Emergency stop"},
            ].map(({cmd,desc})=>(
              <div key={cmd} style={{display:"flex",gap:12,padding:"6px 0",borderBottom:`1px solid ${C.border}15`,alignItems:"center"}}>
                <code style={{color:C.accent,fontSize:10,fontFamily:"'JetBrains Mono',monospace",flex:1}}>{cmd}</code>
                <span style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>{desc}</span>
              </div>
            ))}
          </div>
          <div style={{background:`${C.green}0a`,border:`1px solid ${C.green}25`,borderRadius:8,padding:12}}>
            <div style={{color:C.green,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:4}}>
              Add Telegram Alerts (recommended)
            </div>
            <div style={{color:C.dim,fontSize:10,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.7}}>
              {`pip install python-telegram-bot\n\n# In your bot script:\nimport telegram, asyncio\nbot = telegram.Bot(token=os.getenv("TG_TOKEN"))\nasyncio.run(bot.send_message(\n  chat_id=os.getenv("TG_CHAT_ID"),\n  text=f"Trade: {market} +\${profit:.2f}"\n))`}
            </div>
          </div>
        </div>
      )}

      {/* ARCHITECTURE */}
      {deployTab==="arch"&&(
        <div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:16,marginBottom:12}}>
            <div style={{color:C.text,fontSize:12,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:14}}>Full System Architecture</div>
            {/* ASCII-style arch diagram */}
            {[
              {label:"PRICE SOURCES", color:C.sky, items:["Kalshi REST API (authenticated)","Polymarket CLOB API (open, free)","Crypto futures (Binance/Coinbase public)"]},
              {label:"EXECUTION ENGINE (VPS, 24/7)", color:C.green, items:["Python bot — scans every 30s","Scoring engine — same rules as sim","Kelly sizing — same math as sim","Kalshi API — real order placement","Logs all trades to SQLite / CSV"]},
              {label:"MONITORING (Browser, on-demand)", color:C.accent, items:["This dashboard — checks in anytime","Real P&L pulled from Kalshi API","AI Review — analyze recent trades","Alerts via Telegram for big events"]},
            ].map((layer,i)=>(
              <div key={i} style={{marginBottom:14}}>
                {i>0&&<div style={{textAlign:"center",color:C.muted,fontSize:16,marginBottom:8}}>↑ ↓</div>}
                <div style={{border:`1px solid ${layer.color}35`,borderRadius:8,padding:12,background:`${layer.color}06`}}>
                  <div style={{color:layer.color,fontSize:9,fontWeight:700,fontFamily:"'Orbitron',sans-serif",
                    letterSpacing:".1em",textTransform:"uppercase",marginBottom:8}}>{layer.label}</div>
                  {layer.items.map((item,j)=>(
                    <div key={j} style={{color:C.dim,fontSize:11,fontFamily:"'DM Sans',sans-serif",
                      padding:"3px 0",borderBottom:`1px solid ${C.border}15`,lineHeight:1.5}}>→ {item}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:12}}>
              <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>Monthly Costs</div>
              {[["DigitalOcean VPS","$6"],["Kalshi account","Free"],["Polymarket API","Free"],["Telegram bot","Free"],["Total","$6/mo"]].map(([l,v])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",
                  borderBottom:`1px solid ${C.border}15`}}>
                  <span style={{color:C.dim,fontSize:10,fontFamily:"'DM Sans',sans-serif"}}>{l}</span>
                  <span style={{color:l==="Total"?C.green:C.text,fontSize:10,fontFamily:"'JetBrains Mono',monospace",fontWeight:l==="Total"?700:400}}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:12}}>
              <div style={{color:C.text,fontSize:11,fontWeight:600,fontFamily:"'DM Sans',sans-serif",marginBottom:8}}>Go-Live Checklist</div>
              {["200+ simulation trades analyzed","AI Review shows profitable strategy","Win rate > 65% on executed trades","Profit factor > 1.5","Max drawdown < 15%","API key added in Settings","VPS running + service active","Telegram alerts configured","Start with $50 — scale up slowly"].map((l,i)=>(
                <div key={i} style={{display:"flex",gap:6,padding:"3px 0",borderBottom:`1px solid ${C.border}15`}}>
                  <span style={{color:C.muted,fontSize:10}}>☐</span>
                  <span style={{color:C.dim,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>{l}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  /* ── NAV ── */
  const VIEWS={dashboard:vDashboard,scanner:vScanner,positions:vPositions,analytics:vAnalytics,journal:vJournal,review:vReview,strategies:vStrategies,settings:vSettings};
  const NAV=[
    {id:"dashboard",  label:"Dashboard",   icon:"📊"},
    {id:"scanner",    label:"Scanner",     icon:"📡", badge:eligibleCount||null, bc:C.green},
    {id:"positions",  label:"Positions",   icon:"💼", badge:positions.length||null, bc:C.amber},
    {id:"analytics",  label:"P&L",         icon:"📈"},
    {id:"journal",    label:"Journal",     icon:"📓", badge:tradeLog.length||null, bc:C.purple},
    {id:"review",     label:"AI Review",   icon:"🧠"},
    {id:"strategies", label:"Strategies",  icon:"⚙️"},
    {id:"settings",   label:"Settings",    icon:"🔑", badge:!apiSaved?1:null, bc:C.amber},
  ];
  const totalPnl=bankroll-START_BANKROLL;

  return(
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"'DM Sans',sans-serif",display:"flex",flexDirection:"column"}}>
      <FontLink/>

      {/* LIVE MODE CONFIRMATION MODAL */}
      {liveConfirm&&(
        <div style={{position:"fixed",inset:0,background:"#00000099",zIndex:999,
          display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:C.surface,border:`1px solid ${C.red}50`,borderRadius:12,
            padding:24,maxWidth:420,width:"100%",boxShadow:"0 16px 48px #00000088"}}>
            <div style={{color:C.red,fontSize:14,fontWeight:700,fontFamily:"'Orbitron',sans-serif",
              letterSpacing:".06em",marginBottom:10}}>⚠ Switch to Live Trading?</div>
            <div style={{color:C.text,fontSize:12,fontFamily:"'DM Sans',sans-serif",lineHeight:1.8,marginBottom:16}}>
              This will connect to your real Kalshi account. All executed trades will place
              {" "}<strong>real orders</strong> using <strong>real funds</strong>.
            </div>
            <div style={{background:`${C.red}0a`,border:`1px solid ${C.red}20`,borderRadius:7,
              padding:"10px 12px",marginBottom:16}}>
              {[
                {done:tradeLog.length>=50,  label:`${tradeLog.length}/50+ simulation trades run`},
                {done:metrics.winRate>=0.6,  label:`Win rate ≥60% (${tradeLog.length?fmtP(metrics.winRate):"no data"})`},
                {done:metrics.profitFactor>=1.3, label:`Profit factor ≥1.3 (${tradeLog.length?metrics.profitFactor.toFixed(2):"no data"})`},
                {done:metrics.mdd<0.15,    label:`Max drawdown < 15% (${fmtP(metrics.mdd)})`},
                {done:apiSaved,            label:"Kalshi API credentials loaded"},
              ].map((item,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0"}}>
                  <span style={{color:item.done?C.green:C.red,fontSize:12}}>{item.done?"✓":"✗"}</span>
                  <span style={{color:item.done?C.dim:C.red,fontSize:10,
                    fontFamily:"'DM Sans',sans-serif"}}>{item.label}</span>
                </div>
              ))}
            </div>
            <div style={{color:C.muted,fontSize:10,fontFamily:"'DM Sans',sans-serif",marginBottom:16,lineHeight:1.6}}>
              Recommendation: start with a small bankroll ($50–100) until you confirm live fills match simulation.
            </div>
            <div style={{display:"flex",gap:10}}>
              <Btn onClick={()=>{setLiveMode(true);setLiveConfirm(false);setBotOn(false);}}
                color={C.red} fill>Yes — go live</Btn>
              <Btn onClick={()=>setLiveConfirm(false)} color={C.muted}>Cancel</Btn>
            </div>
          </div>
        </div>
      )}
      {/* RESTORED BANNER */}
      {restored&&(
        <div style={{background:`${C.green}12`,borderBottom:`1px solid ${C.green}25`,
          padding:"6px 18px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{color:C.green,fontSize:10,fontFamily:"'DM Sans',sans-serif",fontWeight:600}}>
            ✓ Session restored — {tradeLog.length} trades, bankroll ${bankroll.toFixed(2)}
          </span>
          <Btn small onClick={()=>setRestored(false)} color={C.muted}>Dismiss</Btn>
        </div>
      )}
      {/* TOPBAR */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"0 18px",height:50,
        display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontFamily:"'Orbitron',sans-serif",fontSize:14,fontWeight:900,color:C.accent,letterSpacing:".05em"}}>APEX<span style={{color:C.green}}>PM</span></span>

          {/* Mode pill — click to toggle */}
          <div style={{position:"relative"}} data-modepopover="1">
            <div onClick={()=>setModePopover(p=>!p)} style={{
              display:"flex", alignItems:"center", gap:5,
              padding:"3px 9px", borderRadius:20, cursor:"pointer",
              background: liveMode ? `${C.red}22` : `${C.amber}18`,
              border:`1px solid ${liveMode ? C.red+"60" : C.amber+"50"}`,
              color: liveMode ? C.red : C.amber,
              fontSize:10, fontFamily:"'JetBrains Mono',monospace", fontWeight:700,
              userSelect:"none", transition:"all .15s",
            }}>
              {liveMode ? "🔴 LIVE" : "🟡 SIM"}
              <span style={{fontSize:8, opacity:.7}}>▾</span>
            </div>

            {/* Popover */}
            {modePopover&&(
              <div style={{
                position:"absolute", top:"calc(100% + 8px)", left:0,
                background:C.surface, border:`1px solid ${C.borderHi}`,
                borderRadius:10, padding:16, width:260, zIndex:200,
                boxShadow:"0 8px 32px #00000088",
              }}>
                {/* Current mode */}
                <div style={{color:C.dim,fontSize:9,fontFamily:"'DM Sans',sans-serif",
                  textTransform:"uppercase",letterSpacing:".07em",marginBottom:10}}>Trading Mode</div>

                {/* Sim option */}
                <div onClick={()=>{setLiveMode(false);setLiveConfirm(false);setModePopover(false);}} style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                  padding:"9px 11px", borderRadius:7, marginBottom:6, cursor:"pointer",
                  background: !liveMode ? `${C.amber}15` : "transparent",
                  border:`1px solid ${!liveMode ? C.amber+"50" : C.border}`,
                }}>
                  <div>
                    <div style={{color:C.amber,fontSize:11,fontWeight:700,fontFamily:"'DM Sans',sans-serif"}}>🟡 Simulation</div>
                    <div style={{color:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif",marginTop:2}}>No real orders · safe to run freely</div>
                  </div>
                  {!liveMode&&<span style={{color:C.amber,fontSize:14}}>✓</span>}
                </div>

                {/* Live option */}
                <div onClick={()=>{
                  if(!apiSaved){ setModePopover(false); setView("settings"); return; }
                  if(!liveMode){ setLiveConfirm(true); setModePopover(false); }
                }} style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                  padding:"9px 11px", borderRadius:7, cursor:"pointer",
                  background: liveMode ? `${C.red}15` : "transparent",
                  border:`1px solid ${liveMode ? C.red+"50" : C.border}`,
                  opacity: !apiSaved ? 0.5 : 1,
                }}>
                  <div>
                    <div style={{color:C.red,fontSize:11,fontWeight:700,fontFamily:"'DM Sans',sans-serif"}}>🔴 Live Trading</div>
                    <div style={{color:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif",marginTop:2}}>
                      {apiSaved ? "Real orders on Kalshi · real funds" : "⚠ Add API key in Settings first"}
                    </div>
                  </div>
                  {liveMode&&<span style={{color:C.red,fontSize:14}}>✓</span>}
                </div>

                {/* Checklist mini */}
                <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
                  <div style={{color:C.muted,fontSize:8,fontFamily:"'DM Sans',sans-serif",
                    textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>Pre-live status</div>
                  {[
                    {done:tradeLog.length>=50,  label:`${tradeLog.length}/50 sim trades`},
                    {done:metrics.winRate>=0.6,  label:`Win rate ≥60% (${tradeLog.length?fmtP(metrics.winRate):"—"})`},
                    {done:metrics.profitFactor>=1.3, label:`PF ≥1.3 (${tradeLog.length?metrics.profitFactor.toFixed(2):"—"})`},
                    {done:apiSaved,             label:"API key loaded"},
                  ].map((item,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                      <span style={{color:item.done?C.green:C.muted,fontSize:11,lineHeight:1}}>{item.done?"✓":"○"}</span>
                      <span style={{color:item.done?C.dim:C.muted,fontSize:9,fontFamily:"'DM Sans',sans-serif"}}>{item.label}</span>
                    </div>
                  ))}
                </div>

                <div style={{marginTop:10,textAlign:"center"}}>
                  <span onClick={()=>{setModePopover(false);setView("settings");}}
                    style={{color:C.accent,fontSize:9,fontFamily:"'DM Sans',sans-serif",
                    cursor:"pointer",textDecoration:"underline"}}>
                    Full settings →
                  </span>
                </div>
              </div>
            )}
          </div>

          <Badge color={C.teal} tiny>⚡ Kalshi</Badge>
          {botOn&&<Badge color={C.green} tiny>● ACTIVE</Badge>}
          {saveStatus==="saving"&&<Badge color={C.dim} tiny>💾 Saving…</Badge>}
          {saveStatus==="saved"&&<Badge color={C.green} tiny>💾 Saved</Badge>}
          {saveStatus==="error"&&<Badge color={C.red} tiny>⚠ Save failed</Badge>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div style={{textAlign:"right"}}>
            <div style={{color:C.accent,fontFamily:"'Orbitron',sans-serif",fontSize:13,fontWeight:700}}>${bankroll.toFixed(2)}</div>
            <div style={{color:totalPnl>=0?C.green:C.red,fontSize:8,fontFamily:"'JetBrains Mono',monospace"}}>{fmt$(totalPnl)}</div>
          </div>
          <Btn onClick={()=>setBotOn(!botOn)} color={botOn?C.red:C.green} fill small>{botOn?"⏹ Stop":"▶ Run"}</Btn>
        </div>
      </div>

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {/* SIDEBAR */}
        <div style={{width:180,background:C.surface,borderRight:`1px solid ${C.border}`,
          padding:"10px 8px",flexShrink:0,display:"flex",flexDirection:"column",gap:2,overflowY:"auto"}}>
          {NAV.map(n=>(
            <div key={n.id} onClick={()=>setView(n.id)} style={{display:"flex",alignItems:"center",gap:9,
              padding:"8px 11px",borderRadius:6,cursor:"pointer",userSelect:"none",
              background:view===n.id?`${C.accent}12`:"transparent",
              border:`1px solid ${view===n.id?C.accent+"30":"transparent"}`,
              color:view===n.id?C.accent:C.dim,fontSize:12,fontWeight:view===n.id?600:400,transition:"all .14s"}}>
              <span style={{fontSize:14}}>{n.icon}</span>
              <span style={{flex:1}}>{n.label}</span>
              {n.badge>0&&<span style={{background:n.bc,color:n.bc===C.amber?C.bg:"#fff",
                borderRadius:10,padding:"0 5px",fontSize:8,fontWeight:700,lineHeight:"14px"}}>{n.badge}</span>}
            </div>
          ))}
          <div style={{marginTop:"auto",padding:"10px 8px",borderTop:`1px solid ${C.border}`}}>
            <div style={{color:C.muted,fontSize:8,textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Session</div>
            {[["Trades",metrics.trades],["Auto Fired",metrics.autoFired],["Conv Exits",metrics.convExits],
              ["Win Rate",metrics.winRate>0?fmtP(metrics.winRate):"—"],["Avg Fill",metrics.avgFill>0?fmtP(metrics.avgFill):"—"]].map(([l,v])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                <span style={{color:C.muted,fontSize:9}}>{l}</span>
                <span style={{color:C.text,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        {/* MAIN */}
        <div style={{flex:1,overflow:"auto",padding:"18px 22px"}}>{VIEWS[view]}</div>
      </div>

      {/* MOBILE NAV */}
      <div style={{background:C.surface,borderTop:`1px solid ${C.border}`,display:"none",padding:"4px 0",flexShrink:0}} id="mobnav">
        {NAV.slice(0,5).map(n=>(
          <div key={n.id} onClick={()=>setView(n.id)} style={{flex:1,textAlign:"center",cursor:"pointer",padding:"4px 2px",color:view===n.id?C.accent:C.muted,fontSize:8}}>
            <div style={{fontSize:18,position:"relative",display:"inline-block"}}>
              {n.icon}
              {n.badge>0&&<span style={{position:"absolute",top:-3,right:-5,background:n.bc,color:"#fff",borderRadius:6,padding:"0 3px",fontSize:7,lineHeight:"12px"}}>{n.badge}</span>}
            </div>
            <div>{n.label}</div>
          </div>
        ))}
      </div>
      <style>{`@media(max-width:680px){#mobnav{display:flex!important}}`}</style>
    </div>
  );
}
