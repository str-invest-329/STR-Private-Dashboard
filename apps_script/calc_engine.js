// =============================================================================
// STR Alpha 計算引擎（核心計算邏輯）
// =============================================================================
//
// 資料流：
//   事件表（輸入）          →  計算引擎  →  狀態表（輸出）
//   ─────────────────       ──────────    ─────────────────
//   帳戶事件表               calcAll()     帳戶狀態表
//   股票事件表                             股票狀態表-帳戶
//   股票設定表                                 股票狀態表-標的
//   帳戶設定表（Reference）                 市場狀態表（僅投資帳戶）
//                                          全倉狀態表（僅投資帳戶）
//
// =============================================================================
//
// 指標定義：
//
//   【帳戶層級】
//   總資本(Total Capital)           = SUM(CAPITAL_TYPES 交易)               ← 所有資金來源（股本+換匯+轉帳+領現，未來可含借款）
//   持倉成本(Position Cost)         = SUM(持有中股票的成本總額)             ← 目前投入股票的金額
//   已實現損益(Capital Gains)         = SUM(所有賣出交易的損益)              ← 買賣股票的已確定盈虧
//   利息與股息(Income)                    = SUM(利息 + 配息 + 定存利息 + ...)    ← 所有持有期間的被動收入
//   其他收入(Other Income)          = SUM(其他類交易金額)                   ← 畸零股退還/手續費退還等，計入現金但不計入資本與損益
//   什支(Expenses)                  = SUM(什支類交易的金額絕對值)           ← 軟體費用等非投資支出
//   定存(Time Deposits)             = SUM(定存存入) - SUM(定存到期)        ← 當前鎖定的定存金額
//   可用現金(Available Cash)        = 總資本 - 持倉成本 + 已實現損益 + 利息與股息 + 其他收入 - 定存 - 什支
//   持倉市值(Market Value)          = 該帳戶持有股票的現價 × 股數 加總
//   總負債(Total Debt)              = SUM(DEBT_TYPES 交易)                 ← 融資等借入資金（目前為0）
//   NAV(Net Asset Value)            = 總資產 - 總負債                      ← 扣除負債後的真實淨值
//   未實現股票損益(Unrealized Equity P&L) = 持倉市值 - 持倉成本
//   未實現股票損益率(Unrealized Equity Rate) = 未實現股票損益 / 持倉成本
//   未實現總損益(Unrealized Total P&L)    = 未實現股票損益（目前相等，未來有債券等浮動資產時會不同）
//   未實現總損益率(Unrealized Total Rate) = 未實現總損益 / 總資本
//   已實現股票損益(Realized Equity P&L)   = 賣出損益累計
//   已實現總損益(Realized Total P&L)      = 已實現股票損益 + 利息與股息 - 什支
//   已實現總損益率(Realized Total Rate)   = 已實現總損益 / 總資本
//   總損益(Total P&L)               = 已實現總損益 + 未實現總損益
//   總損益率(Total Return)          = 總損益 / 總資本
//
//   【股票層級】
//   持有股數       = SUM(買入股數) - SUM(賣出股數)
//   平均成本       = 加權平均（買入時累加，賣出時按平均成本移除）
//   持有成本總額   = 平均成本 × 持有股數
//   累計已實現損益 = SUM(每次賣出: 賣出所得 - 移除成本)
//   累計已實現股息 = SUM(該標的在帳戶事件表中的配息金額)
//   現價           = 從股票設定表 VLOOKUP
//   持倉市值(Market Value)          = 現價 × 持有股數
//   未實現損益(Unrealized P&L)      = 持倉市值 - 持有成本總額
//   未實現損益率(Unrealized Return) = 未實現損益 / 持有成本總額
//   持倉占比(Position Weight)       = 持有成本總額 / 該市場淨資產
//
//   【市場層級】（美股 / 台股）
//   以上指標按市場聚合（僅投資帳戶）
//   以上帳戶層級的所有指標按市場聚合（僅投資帳戶）
//
//   【全倉層級】
//   所有市場加總
//
// =============================================================================

// ===== 設定 =====
var CONFIG = {
  // 幣別 → 市場 的對應
  CURRENCY_TO_MARKET: { "USD": "美股", "TWD": "台股" },
  DEFAULT_MARKET: "美股",

  // 市場 → 幣別 的對應
  CURRENCY_MAP: { "美股": "USD", "台股": "TWD" },

  // 來源表名
  SOURCE: {
    TRADES: "股票事件表",
    ACCOUNT_EVENTS: "帳戶事件表",
    DEPOSIT_EVENTS: "定存事件表",
    PRICES: "股票設定表",
    ACCOUNT_CONFIG: "帳戶設定表",
    EVENT_TYPE_CONFIG: "事件類型設定表"
  },

  // 輸出表名
  OUTPUT: {
    EQUITY_BY_ACCOUNT: "股票狀態表-帳戶",
    EQUITY_BY_TICKER: "股票狀態表-標的",
    ACCOUNT_STATUS: "帳戶狀態表",
    MARKET_STATUS: "市場狀態表",
    PORTFOLIO_STATUS: "全倉狀態表",
    DEPOSIT_STATUS: "定存狀態表-帳戶"
  },

  // 事件類型分類對應（從「事件類型設定表」動態讀取，以下為 fallback）
  CAPITAL_TYPES: ["股本", "換匯", "轉帳", "領現"],
  INTEREST_TYPES: ["利息", "配息", "定存利息"],
  EXPENSE_TYPES: ["什支"],
  DEBT_TYPES: ["融資", "還融資"],
  DEPOSIT_IN_TYPES: ["定存存入"],
  DEPOSIT_OUT_TYPES: ["定存到期"],
  IGNORE_TYPES: ["買股", "賣股"],
  OTHER_TYPES: ["其他"]
};

// ===== 從事件類型設定表讀取分類 =====
// 讀取「事件類型設定表」，覆蓋 CONFIG 中的硬編碼分類
// 分類對應：資本→CAPITAL_TYPES, 利息→INTEREST_TYPES, 支出→EXPENSE_TYPES,
//           負債→DEBT_TYPES, 定存+→DEPOSIT_IN_TYPES, 定存-→DEPOSIT_OUT_TYPES,
//           忽略→IGNORE_TYPES, 其他→OTHER_TYPES
function loadEventTypeConfig(ss) {
  var sheet = readSheet(ss, CONFIG.SOURCE.EVENT_TYPE_CONFIG);
  if (!sheet) return; // 讀不到就用 fallback

  var categoryMap = {
    "資本": [], "利息": [], "支出": [], "負債": [],
    "定存轉入": [], "定存轉出": [], "忽略": [], "其他": []
  };

  for (var i = 0; i < sheet.data.length; i++) {
    var row = sheet.data[i];
    var eventType = String(row[sheet.col("事件類型")]).trim();
    var category = String(row[sheet.col("分類")]).trim();
    if (!eventType || !category) continue;
    if (categoryMap[category]) {
      categoryMap[category].push(eventType);
    }
  }

  // 只有成功讀到資料才覆蓋（至少要有一個資本類型）
  if (categoryMap["資本"].length > 0) {
    CONFIG.CAPITAL_TYPES = categoryMap["資本"];
    CONFIG.INTEREST_TYPES = categoryMap["利息"];
    CONFIG.EXPENSE_TYPES = categoryMap["支出"];
    CONFIG.DEBT_TYPES = categoryMap["負債"];
    CONFIG.DEPOSIT_IN_TYPES = categoryMap["定存轉入"];
    CONFIG.DEPOSIT_OUT_TYPES = categoryMap["定存轉出"];
    CONFIG.IGNORE_TYPES = categoryMap["忽略"];
    CONFIG.OTHER_TYPES = categoryMap["其他"];
  }
}

// ===== 驗證事件類型 =====
// 檢查帳戶事件表中是否有未在設定表定義的事件類型
function validateEventTypes(accountEvents) {
  var typeCol = accountEvents.col("事件類型");
  if (typeCol === -1) typeCol = accountEvents.col("交易類型");

  var allKnown = [].concat(
    CONFIG.CAPITAL_TYPES, CONFIG.INTEREST_TYPES, CONFIG.EXPENSE_TYPES,
    CONFIG.DEBT_TYPES, CONFIG.DEPOSIT_IN_TYPES, CONFIG.DEPOSIT_OUT_TYPES,
    CONFIG.IGNORE_TYPES, CONFIG.OTHER_TYPES
  );

  var unknown = {};
  for (var i = 0; i < accountEvents.data.length; i++) {
    var type = String(accountEvents.data[i][typeCol]).trim();
    if (!type) continue;
    if (allKnown.indexOf(type) < 0 && !unknown[type]) {
      unknown[type] = i + 2; // Sheet 行號
    }
  }

  var unknownList = Object.keys(unknown);
  if (unknownList.length > 0) {
    var msg = "⚠️ 帳戶事件表有未定義的事件類型（不會被計算）：\n";
    for (var j = 0; j < unknownList.length; j++) {
      msg += "  • 「" + unknownList[j] + "」（首次出現在第 " + unknown[unknownList[j]] + " 行）\n";
    }
    msg += "\n請到「事件類型設定表」新增分類。";
    SpreadsheetApp.getUi().alert(msg);
  }
}

// ===== 市場判斷 =====
// 用幣別判斷市場：USD → 美股，TWD → 台股
function getMarketByCurrency(currency) {
  return CONFIG.CURRENCY_TO_MARKET[currency] || CONFIG.DEFAULT_MARKET;
}


function getCurrency(market) {
  return CONFIG.CURRENCY_MAP[market] || "USD";
}

// =============================================================================
// 主函數
// =============================================================================
function recalcAll() {
  var ss = SpreadsheetApp.openById("1_gy-srj_7ejRyEPt_b51dovt_Ka8caAyN9E6nEYxPF4");

  // 0. 從事件類型設定表載入分類（覆蓋 CONFIG 中的硬編碼）
  loadEventTypeConfig(ss);

  // 1. 讀取所有來源資料
  var trades = readSheet(ss, CONFIG.SOURCE.TRADES);
  var accountEvents = readSheet(ss, CONFIG.SOURCE.ACCOUNT_EVENTS);
  var prices = readSheet(ss, CONFIG.SOURCE.PRICES);
  var accountConfig = readSheet(ss, CONFIG.SOURCE.ACCOUNT_CONFIG);

  if (!trades || !accountEvents) {
    SpreadsheetApp.getUi().alert("找不到事件表");
    return;
  }

  // 1.5 驗證事件類型（有未定義的類型會彈警告）
  validateEventTypes(accountEvents);

  // 2. 建立帳戶設定對照表（是否為投資帳戶）
  var investmentMap = buildInvestmentMap(accountConfig);

  // 3. 計算
  var priceMap = buildPriceMap(prices);
  var positions = calcPositions(trades);
  var dividendMap = calcDividends(accountEvents);
  var equityByAcct = buildEquityByAccount(positions, dividendMap, priceMap);
  var accountStatus = calcAccountStatus(accountEvents, equityByAcct, accountConfig);
  enrichAccountMarketValue(accountStatus, equityByAcct);
  var equityByAcct = enrichCostRatio(equityByAcct, accountStatus, investmentMap);
  var equityByTicker = aggregateByTicker(equityByAcct, accountStatus, investmentMap);
  var marketStatus = aggregateByMarket(accountStatus, equityByAcct, investmentMap);
  var portfolioStatus = aggregatePortfolio(marketStatus);

  // 3. 寫入所有狀態表
  writeEquityByAccount(ss, equityByAcct);
  writeEquityByTicker(ss, equityByTicker);
  writeAccountStatus(ss, accountStatus);
  writeMarketStatus(ss, marketStatus);
  calcDepositStatus(ss);
  // writePortfolioStatus(ss, portfolioStatus); // 暫停：全倉需匯率換算，待後續實現

  Logger.log("全部狀態表重算完成！");
}

// =============================================================================
// 計算模組
// =============================================================================

// ----- 建立帳戶投資屬性對照表 -----
// 回傳 map: "銀行|帳戶|幣別" → true/false
function buildInvestmentMap(accountConfig) {
  var map = {};
  if (!accountConfig) return map;
  for (var i = 0; i < accountConfig.data.length; i++) {
    var row = accountConfig.data[i];
    var bank = String(row[accountConfig.col("銀行")]).trim();
    var account = String(row[accountConfig.col("帳戶名")]).trim();
    var currency = String(row[accountConfig.col("幣別")]).trim();
    var isInvestment = row[accountConfig.col("是否投資帳戶")];
    // Google Sheets 的 TRUE/FALSE 會被讀成 boolean 或字串
    var flag = (isInvestment === true || String(isInvestment).toUpperCase() === "TRUE");
    var key = bank + "|" + account + "|" + currency;
    map[key] = flag;
  }
  return map;
}

// 判斷帳戶是否為投資帳戶（預設 true，設定表有設 false 才排除）
function isInvestmentAccount(investmentMap, bank, account, currency) {
  var key = bank + "|" + account + "|" + currency;
  if (key in investmentMap) return investmentMap[key];
  return true; // 預設為投資帳戶
}

// ----- 建立股價對照表 -----
function buildPriceMap(prices) {
  var map = {};
  if (!prices) return map;
  for (var i = 0; i < prices.data.length; i++) {
    var ticker = String(prices.data[i][prices.col("Ticker")]).trim();
    var price = Number(prices.data[i][prices.col("現價")]) || 0;
    if (ticker) map[ticker] = price;
  }
  return map;
}

// ----- 計算持倉：加權平均成本 -----
// 買入時：成本累加，重算加權平均
// 賣出時：用當時平均成本計算移除成本，差額 = 已實現損益
function calcPositions(trades) {
  var positions = {};

  // 收集所有交易
  for (var i = 0; i < trades.data.length; i++) {
    var row = trades.data[i];
    var stock = String(row[trades.col("Ticker")]).trim();
    if (!stock) continue;

    var bank = String(row[trades.col("銀行")]);
    var account = String(row[trades.col("帳戶名")]);
    var key = bank + "|" + account + "|" + stock;

    var currency = String(row[trades.col("幣別")]);

    if (!positions[key]) {
      positions[key] = { bank: bank, account: account, stock: stock, currency: currency, trades: [] };
    }

    var splitNewQtyCol = trades.col("分割/反分割後新股");
    var direction = String(row[trades.col("方向")]);
    if (direction.indexOf("分割") >= 0 || direction.indexOf("合併") >= 0) {
      Logger.log("[SPLIT DEBUG] Ticker=" + stock + " 方向=" + direction +
        " splitCol=" + splitNewQtyCol +
        " splitVal=" + (splitNewQtyCol >= 0 ? row[splitNewQtyCol] : "N/A") +
        " 股數=" + row[trades.col("股數")]);
      Logger.log("[HEADERS] " + trades.headers.join("|"));
    }
    positions[key].trades.push({
      date: row[trades.col("日期")],
      direction: direction,
      price: Number(row[trades.col("價格")]),
      qty: Number(row[trades.col("股數")]),
      fee: Number(row[trades.col("手續費")]),
      total: Number(row[trades.col("成交金額")]),
      splitQty: splitNewQtyCol >= 0 ? (Number(row[splitNewQtyCol]) || 0) : 0
    });
  }

  // 逐筆計算加權平均
  for (var key in positions) {
    var p = positions[key];
    p.trades.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

    var holdQty = 0, holdCost = 0, avgCost = 0, realizedPnL = 0;

    for (var i = 0; i < p.trades.length; i++) {
      var t = p.trades[i];

      if (t.direction === "買" || t.direction === "買股") {
        // 買入：持有成本 += 成交金額絕對值（含手續費），重算平均
        holdCost += Math.abs(t.total);
        holdQty += t.qty;
        avgCost = holdQty > 0 ? holdCost / holdQty : 0;

      } else if (t.direction === "賣" || t.direction === "賣股") {
        // 賣出：移除成本 = 平均成本 × 賣出股數
        var costRemoved = avgCost * Math.abs(t.qty);
        // 賣出所得 = 成交金額（已包含手續費+證交稅等所有費用）
        var proceeds = Math.abs(t.total);
        // 已實現損益 = 賣出所得 - 移除成本
        realizedPnL += proceeds - costRemoved;

        holdCost -= costRemoved;
        holdQty -= t.qty;

        if (holdQty <= 0) { holdQty = 0; holdCost = 0; avgCost = 0; }

      } else if (t.direction === "反分割" || t.direction === "正分割" || t.direction === "分割") {
        // 股票分割／反分割：成本總額不變，股數改為「分割後新股」欄的數值，重算平均成本
        // 「股數」欄維持原意（交易買賣數量），此處使用專屬欄「分割後新股」
        // 不影響已實現損益
        var newQty = t.splitQty > 0 ? t.splitQty : Math.abs(t.qty); // 優先用分割後新股，否則退回股數欄
        holdQty = newQty;
        avgCost = holdQty > 0 ? holdCost / holdQty : 0;
      }
    }

    p.qty = holdQty;
    p.totalCost = holdCost;
    p.avgCost = avgCost;
    p.realizedPnL = realizedPnL;
    delete p.trades;
  }

  return positions;
}

// ----- 計算股息（從帳戶事件表的「標的」欄位讀取） -----
function calcDividends(accountEvents) {
  var dividends = {};

  // 欄位名稱相容：支援「交易類型」和「事件類型」
  var typeCol = accountEvents.col("事件類型");
  if (typeCol === -1) typeCol = accountEvents.col("交易類型");
  var stockCol = accountEvents.col("Ticker");

  for (var i = 0; i < accountEvents.data.length; i++) {
    var row = accountEvents.data[i];
    if (String(row[typeCol]) !== "配息") continue;

    var bank = String(row[accountEvents.col("銀行")]);
    var account = String(row[accountEvents.col("帳戶名")]);
    var amount = Number(row[accountEvents.col("金額")]);

    // 優先從「標的」欄位讀取
    var stock = "";
    if (stockCol >= 0 && row[stockCol]) {
      stock = String(row[stockCol]).trim();
    }

    // 備援：如果「標的」欄為空，嘗試從摘要提取（相容舊資料）
    if (!stock) {
      var summary = String(row[accountEvents.col("摘要")]);
      var match = summary.match(/配息-(.+?)-/);
      stock = match ? match[1] : "";
    }

    if (!stock) continue;

    var key = bank + "|" + account + "|" + stock;
    dividends[key] = (dividends[key] || 0) + amount;
  }

  return dividends;
}

// ----- 組裝股票狀態（按帳戶）-----
function buildEquityByAccount(positions, dividendMap, priceMap) {
  var result = [];

  for (var key in positions) {
    var p = positions[key];
    var dKey = p.bank + "|" + p.account + "|" + p.stock;
    var market = getMarketByCurrency(p.currency);
    var currentPrice = priceMap[p.stock] || 0;

    // 持倉市值 = 現價 × 持有股數
    var marketValue = p.qty * currentPrice;
    // 未實現損益 = 持倉市值 - 持有成本（僅有持倉時計算）
    var unrealizedPnL = p.qty > 0 ? marketValue - p.totalCost : 0;
    // 未實現獲利率 = 未實現損益 / 持有成本
    var unrealizedRate = p.totalCost > 0 ? unrealizedPnL / p.totalCost : 0;

    result.push({
      market: market,
      bank: p.bank,
      account: p.account,
      stock: p.stock,
      currency: p.currency,
      qty: p.qty,
      avgCost: p.avgCost,
      totalCost: p.totalCost,
      realizedPnL: p.realizedPnL,
      dividend: dividendMap[dKey] || 0,
      currentPrice: currentPrice,
      marketValue: marketValue,
      unrealizedPnL: unrealizedPnL,
      unrealizedRate: unrealizedRate,
      costRatio: 0  // 需要總水位，稍後填入
    });
  }

  // 排序：美股在前，有持倉在前
  result.sort(function(a, b) {
    if (a.market !== b.market) return a.market === "美股" ? -1 : 1;
    return b.qty - a.qty;
  });

  return result;
}

// ----- 計算帳戶狀態 -----
function calcAccountStatus(accountEvents, equityByAcct, accountConfig) {
  var accounts = {};

  // 先從帳戶設定表初始化所有帳戶（確保即使沒有事件也會出現在狀態表）
  if (accountConfig) {
    for (var i = 0; i < accountConfig.data.length; i++) {
      var row = accountConfig.data[i];
      var bank = String(row[accountConfig.col("銀行")]).trim();
      var account = String(row[accountConfig.col("帳戶名")]).trim();
      var currency = String(row[accountConfig.col("幣別")]).trim();
      var key = bank + "|" + account + "|" + currency;
      if (!accounts[key]) {
        accounts[key] = {
          bank: bank, account: account, currency: currency,
          capital: 0, invested: 0, realizedPnL: 0, interest: 0, deposit: 0, expense: 0, debt: 0, cash: 0, other: 0
        };
      }
    }
  }

  // 欄位名稱相容：支援「交易類型」和「事件類型」
  var typeCol = accountEvents.col("事件類型");
  if (typeCol === -1) typeCol = accountEvents.col("交易類型");

  // 從帳戶事件表聚合
  for (var i = 0; i < accountEvents.data.length; i++) {
    var row = accountEvents.data[i];
    var type = String(row[typeCol]);
    var bank = String(row[accountEvents.col("銀行")]);
    var account = String(row[accountEvents.col("帳戶名")]);
    var currency = String(row[accountEvents.col("幣別")]);
    var amount = Number(row[accountEvents.col("金額")]);

    var key = bank + "|" + account + "|" + currency;
    if (!accounts[key]) {
      accounts[key] = {
        bank: bank, account: account, currency: currency,
        capital: 0, invested: 0, realizedPnL: 0, interest: 0, deposit: 0, expense: 0, debt: 0, cash: 0
      };
    }
    var a = accounts[key];

    // 資本額 = SUM(股本 + 換匯 + 轉帳)
    if (CONFIG.CAPITAL_TYPES.indexOf(type) >= 0) {
      a.capital += amount;
    }

    // 定存 = SUM(定存存入) - SUM(定存到期)
    if (CONFIG.DEPOSIT_IN_TYPES.indexOf(type) >= 0) a.deposit += Math.abs(amount);
    else if (CONFIG.DEPOSIT_OUT_TYPES.indexOf(type) >= 0) a.deposit -= Math.abs(amount);

    // 利息/配息 = SUM(利息 + 配息 + 定存利息)
    if (CONFIG.INTEREST_TYPES.indexOf(type) >= 0) {
      a.interest += amount;
    }

    // 什支 = SUM(什支)（支出，金額為負數，取絕對值）
    if (CONFIG.EXPENSE_TYPES.indexOf(type) >= 0) {
      a.expense += Math.abs(amount);
    }

    // 負債 = SUM(融資借入為正，還融資為負)
    if (CONFIG.DEBT_TYPES.indexOf(type) >= 0) {
      a.debt += amount; // 融資為正（借入），還融資為負（歸還）
    }

    // 其他 = SUM(其他類金額)（畸零股退還、手續費退還等）
    // 計入可用現金（真實入帳的現金），但不計入總資本、不計入已實現損益/利息/股息
    if (CONFIG.OTHER_TYPES.indexOf(type) >= 0) {
      a.other += amount;
    }
  }

  // 從股票狀態取得投入金額和已實現損益
  for (var i = 0; i < equityByAcct.length; i++) {
    var e = equityByAcct[i];
    var key = e.bank + "|" + e.account + "|" + e.currency;
    if (accounts[key]) {
      // 投入金額 = 持有中股票的成本（已平倉的不算）
      accounts[key].invested += (e.qty > 0 ? e.totalCost : 0);
      // 已實現損益 = 所有賣出的累計損益
      accounts[key].realizedPnL += e.realizedPnL;
    }
  }

  // 可用現金 = 資本額 - 投入金額 + 已實現損益 + 利息/配息 + 其他 - 定存 - 什支
  for (var key in accounts) {
    var a = accounts[key];
    a.cash = a.capital - a.invested + a.realizedPnL + a.interest + a.other - a.deposit - a.expense;
  }

  return accounts;
}

// ----- 補充帳戶的持倉市值、未實現損益、總損益、總報酬率 -----
function enrichAccountMarketValue(accountStatus, equityByAcct) {
  // 初始化
  for (var key in accountStatus) {
    accountStatus[key].marketValue = 0;
    accountStatus[key].unrealizedPnL = 0;
    accountStatus[key].totalPnL = 0;
    accountStatus[key].totalReturn = 0;
  }

  // 從股票狀態聚合持倉市值和未實現損益
  for (var i = 0; i < equityByAcct.length; i++) {
    var e = equityByAcct[i];
    var currency = e.currency;
    var key = e.bank + "|" + e.account + "|" + currency;
    if (accountStatus[key]) {
      accountStatus[key].marketValue += e.marketValue;
      accountStatus[key].unrealizedPnL += e.unrealizedPnL;
    }
  }

  // 計算所有衍生指標
  for (var key in accountStatus) {
    var a = accountStatus[key];

    // === 資產總覽 ===
    // 總資產 = 持倉市值 + 可用現金 + 定存
    a.totalAssets = a.marketValue + a.cash + a.deposit;
    // NAV = 總資產 - 總負債
    a.nav = a.totalAssets - a.debt;

    // === 倉位 ===
    var denominator = a.invested + a.cash + a.deposit;
    a.equityWeight = denominator > 0 ? a.invested / denominator : 0;
    a.cashWeight = denominator > 0 ? (a.cash + a.deposit) / denominator : 0;

    // === 未實現 ===
    // 未實現股票損益 = 持倉市值 - 持倉成本（已在 equityByAcct 聚合）
    // 未實現股票損益率 = 未實現股票損益 / 持倉成本
    a.unrealizedEquityRate = a.invested > 0 ? a.unrealizedPnL / a.invested : 0;
    // 未實現總損益 = 未實現股票損益（目前相等，未來有債券等浮動資產時會不同）
    a.unrealizedTotalPnL = a.unrealizedPnL;
    // 未實現總損益率 = 未實現總損益 / 總資本
    a.unrealizedTotalRate = a.capital > 0 ? a.unrealizedTotalPnL / a.capital : 0;

    // === 已實現 ===
    // 已實現股票損益 = realizedPnL（已在 equityByAcct 聚合）
    // 已實現總損益 = 已實現股票損益 + 利息與股息
    a.realizedTotalPnL = a.realizedPnL + a.interest;
    // 已實現總損益率 = 已實現總損益 / 總資本
    a.realizedTotalRate = a.capital > 0 ? a.realizedTotalPnL / a.capital : 0;

    // === 總損益 ===
    // 總損益 = 已實現總損益 + 未實現總損益
    a.totalPnL = a.realizedTotalPnL + a.unrealizedTotalPnL;
    // 總損益率 = 總損益 / 總資本
    a.totalReturn = a.capital > 0 ? a.totalPnL / a.capital : 0;
  }
}

// ----- 補充投入成本占比（分母 = 剩餘水位 = 投入金額 + 可用現金 + 定存） -----
function enrichCostRatio(equityByAcct, accountStatus, investmentMap) {
  // 先算各市場的剩餘水位（只計入投資帳戶）
  var remainingByMarket = {};
  for (var key in accountStatus) {
    var a = accountStatus[key];
    if (!isInvestmentAccount(investmentMap, a.bank, a.account, a.currency)) continue;
    var market = getMarketByCurrency(a.currency);
    // 剩餘水位 = 投入金額 + 可用現金 + 定存
    var remaining = a.invested + a.cash + a.deposit;
    remainingByMarket[market] = (remainingByMarket[market] || 0) + remaining;
  }

  // 投入成本占比 = 持有成本 / 該市場剩餘水位
  for (var i = 0; i < equityByAcct.length; i++) {
    var e = equityByAcct[i];
    var totalRemaining = remainingByMarket[e.market] || 0;
    e.costRatio = totalRemaining > 0 ? e.totalCost / totalRemaining : 0;
  }

  return equityByAcct;
}

// ----- 聚合：按標的 -----
function aggregateByTicker(equityByAcct, accountStatus, investmentMap) {
  var remainingByMarket = {};
  for (var key in accountStatus) {
    var a = accountStatus[key];
    if (!isInvestmentAccount(investmentMap, a.bank, a.account, a.currency)) continue;
    var market = getMarketByCurrency(a.currency);
    remainingByMarket[market] = (remainingByMarket[market] || 0) + a.invested + a.cash + a.deposit;
  }

  var tickerMap = {};
  for (var i = 0; i < equityByAcct.length; i++) {
    var e = equityByAcct[i];
    var tKey = e.market + "|" + e.stock;

    if (!tickerMap[tKey]) {
      tickerMap[tKey] = {
        market: e.market, stock: e.stock,
        totalQty: 0, totalCost: 0, totalRealizedPnL: 0,
        totalDividend: 0, accountCount: 0, currentPrice: e.currentPrice
      };
    }

    var t = tickerMap[tKey];
    t.totalQty += e.qty;
    t.totalCost += (e.qty > 0 ? e.totalCost : 0);
    t.totalRealizedPnL += e.realizedPnL;
    t.totalDividend += e.dividend;
    if (e.qty > 0) t.accountCount++;
  }

  var result = [];
  for (var tKey in tickerMap) {
    var t = tickerMap[tKey];
    // 平均成本 = 總持有成本 / 總持有股數
    var avgCost = t.totalQty > 0 ? t.totalCost / t.totalQty : 0;
    // 持倉市值 = 現價 × 總持有股數
    var marketValue = t.totalQty * t.currentPrice;
    // 未實現損益 = 持倉市值 - 總持有成本
    var unrealizedPnL = t.totalQty > 0 ? marketValue - t.totalCost : 0;
    // 未實現獲利率 = 未實現損益 / 總持有成本
    var unrealizedRate = t.totalCost > 0 ? unrealizedPnL / t.totalCost : 0;
    // 投入成本占比 = 總持有成本 / 該市場總水位
    var totalRemaining = remainingByMarket[t.market] || 0;
    var costRatio = totalRemaining > 0 ? t.totalCost / totalRemaining : 0;

    result.push({
      market: t.market, stock: t.stock,
      totalQty: t.totalQty, avgCost: avgCost, totalCost: t.totalCost,
      totalRealizedPnL: t.totalRealizedPnL, accountCount: t.accountCount,
      totalDividend: t.totalDividend, currentPrice: t.currentPrice,
      marketValue: marketValue, unrealizedPnL: unrealizedPnL,
      unrealizedRate: unrealizedRate, costRatio: costRatio
    });
  }

  result.sort(function(a, b) {
    if (a.market !== b.market) return a.market === "美股" ? -1 : 1;
    return b.totalQty - a.totalQty;
  });

  return result;
}

// ----- 聚合：按市場（只計入投資帳戶） -----
function aggregateByMarket(accountStatus, equityByAcct, investmentMap) {
  var markets = {};

  // 從帳戶狀態聚合帳戶層指標（只計入投資帳戶）
  for (var key in accountStatus) {
    var a = accountStatus[key];
    if (a.capital === 0) continue;
    if (!isInvestmentAccount(investmentMap, a.bank, a.account, a.currency)) continue;
    var market = getMarketByCurrency(a.currency);

    if (!markets[market]) {
      markets[market] = {
        market: market, capital: 0, invested: 0, realizedPnL: 0,
        interest: 0, expense: 0, other: 0, deposit: 0, cash: 0, debt: 0, marketValue: 0, unrealizedPnL: 0
      };
    }

    var m = markets[market];
    m.capital += a.capital;
    m.invested += a.invested;
    m.realizedPnL += a.realizedPnL;
    m.interest += a.interest;
    m.expense += a.expense;
    m.other += a.other;
    m.deposit += a.deposit;
    m.cash += a.cash;
    m.debt += a.debt;
  }

  // 從股票狀態聚合持倉指標
  for (var i = 0; i < equityByAcct.length; i++) {
    var e = equityByAcct[i];
    if (markets[e.market]) {
      markets[e.market].marketValue += e.marketValue;
      markets[e.market].unrealizedPnL += e.unrealizedPnL;
    }
  }

  // 計算衍生指標
  var result = {};
  for (var market in markets) {
    var m = markets[market];
    // === 資產總覽 ===
    m.totalAssets = m.marketValue + m.cash + m.deposit;
    m.nav = m.totalAssets - m.debt;

    // === 倉位 ===
    var denominator = m.invested + m.cash + m.deposit;
    m.equityWeight = denominator > 0 ? m.invested / denominator : 0;
    m.cashWeight = denominator > 0 ? (m.cash + m.deposit) / denominator : 0;

    // === 未實現 ===
    m.unrealizedEquityRate = m.invested > 0 ? m.unrealizedPnL / m.invested : 0;
    m.unrealizedTotalPnL = m.unrealizedPnL;
    m.unrealizedTotalRate = m.capital > 0 ? m.unrealizedTotalPnL / m.capital : 0;

    // === 已實現 ===
    m.realizedTotalPnL = m.realizedPnL + m.interest - m.expense;
    m.realizedTotalRate = m.capital > 0 ? m.realizedTotalPnL / m.capital : 0;

    // === 總損益 ===
    m.totalPnL = m.realizedTotalPnL + m.unrealizedTotalPnL;
    m.totalReturn = m.capital > 0 ? m.totalPnL / m.capital : 0;
    result[market] = m;
  }

  return result;
}

// ----- 聚合：全倉 -----
function aggregatePortfolio(marketStatus) {
  var p = {
    capital: 0, invested: 0, realizedPnL: 0, interest: 0,
    deposit: 0, cash: 0, marketValue: 0, unrealizedPnL: 0
  };

  for (var market in marketStatus) {
    var m = marketStatus[market];
    p.capital += m.capital;
    p.invested += m.invested;
    p.realizedPnL += m.realizedPnL;
    p.interest += m.interest;
    p.deposit += m.deposit;
    p.cash += m.cash;
    p.marketValue += m.marketValue;
    p.unrealizedPnL += m.unrealizedPnL;
  }

  // 總資產 = 持倉市值 + 可用現金 + 定存
  p.totalAssets = p.marketValue + p.cash + p.deposit;
  // 總損益 = 已實現損益 + 利息/股息 + 未實現損益
  p.totalPnL = p.realizedPnL + p.interest + p.unrealizedPnL;
  // 總報酬率 = 總損益 / 總資本
  p.totalReturn = p.capital > 0 ? p.totalPnL / p.capital : 0;
  // 股票倉位 = 持倉成本 / (持倉成本 + 可用現金 + 定存)
  var denominator = p.invested + p.cash + p.deposit;
  p.equityWeight = denominator > 0 ? p.invested / denominator : 0;
  // 現金倉位 = (可用現金 + 定存) / (持倉成本 + 可用現金 + 定存)
  p.cashWeight = denominator > 0 ? (p.cash + p.deposit) / denominator : 0;

  return p;
}

// =============================================================================
// 寫入模組
// =============================================================================

function writeEquityByAccount(ss, data) {
  var rows = data.map(function(e) {
    return [
      e.market, e.bank, e.account, e.stock,
      e.qty,
      e.qty > 0 ? e.avgCost : "-",
      e.qty > 0 ? e.totalCost : 0,
      e.realizedPnL, e.dividend,
      e.currentPrice, e.marketValue, e.unrealizedPnL,
      e.unrealizedRate, e.costRatio
    ];
  });

  writeState(ss, CONFIG.OUTPUT.EQUITY_BY_ACCOUNT,
    ["市場", "銀行", "帳戶名", "Ticker",
     "持有股數", "平均成本", "持有成本總額",
     "累計已實現損益", "累計已實現股息",
     "現價", "持倉市值", "未實現損益",
     "未實現損益率", "持倉占比"],
    rows
  );
}

function writeEquityByTicker(ss, data) {
  var rows = data.map(function(t) {
    return [
      t.market, t.stock,
      t.totalQty,
      t.totalQty > 0 ? t.avgCost : "-",
      t.totalCost, t.totalRealizedPnL, t.accountCount, t.totalDividend,
      t.currentPrice, t.marketValue, t.unrealizedPnL,
      t.unrealizedRate, t.costRatio
    ];
  });

  writeState(ss, CONFIG.OUTPUT.EQUITY_BY_TICKER,
    ["市場", "Ticker",
     "總持有股數", "平均成本", "總持有成本",
     "累計已實現損益", "持倉帳戶數", "累計已實現股息",
     "現價", "總持倉市值", "未實現損益",
     "未實現損益率", "持倉占比"],
    rows
  );
}

function writeAccountStatus(ss, accountStatus) {
  var rows = [];
  for (var key in accountStatus) {
    var a = accountStatus[key];
    if (a.capital === 0) continue;
    rows.push([
      a.bank, a.account, a.currency,
      a.capital, a.totalAssets, a.debt, a.nav,
      a.equityWeight, a.cashWeight,
      a.totalPnL, a.totalReturn,
      a.unrealizedTotalPnL, a.unrealizedTotalRate,
      a.unrealizedPnL, a.unrealizedEquityRate,
      a.realizedTotalPnL, a.realizedTotalRate,
      a.realizedPnL, a.interest, a.expense, a.other,
      a.invested, a.marketValue,
      a.cash, a.deposit
    ]);
  }
  rows.sort(function(a, b) {
    if (a[2] !== b[2]) return a[2] === "USD" ? -1 : 1;
    return a[1].localeCompare(b[1]);
  });

  writeState(ss, CONFIG.OUTPUT.ACCOUNT_STATUS,
    ["銀行", "帳戶名", "幣別",
     "總資本", "總資產", "總負債", "NAV",
     "股票倉位", "現金倉位",
     "總損益", "總損益率",
     "未實現總損益", "未實現總損益率",
     "未實現股票損益", "未實現股票損益率",
     "已實現總損益", "已實現總損益率",
     "已實現股票損益", "利息與股息", "什支", "其他",
     "持倉成本", "持倉市值",
     "可用現金", "定存"],
    rows
  );
}

function writeMarketStatus(ss, marketStatus) {
  var order = ["美股", "台股"];
  var rows = [];
  for (var i = 0; i < order.length; i++) {
    var m = marketStatus[order[i]];
    if (!m) continue;
    rows.push([
      m.market,
      m.capital, m.totalAssets, m.debt, m.nav,
      m.equityWeight, m.cashWeight,
      m.totalPnL, m.totalReturn,
      m.unrealizedTotalPnL, m.unrealizedTotalRate,
      m.unrealizedPnL, m.unrealizedEquityRate,
      m.realizedTotalPnL, m.realizedTotalRate,
      m.realizedPnL, m.interest, m.expense, m.other,
      m.invested, m.marketValue,
      m.cash, m.deposit
    ]);
  }

  writeState(ss, CONFIG.OUTPUT.MARKET_STATUS,
    ["市場",
     "總資本", "總資產", "總負債", "NAV",
     "股票倉位", "現金倉位",
     "總損益", "總損益率",
     "未實現總損益", "未實現總損益率",
     "未實現股票損益", "未實現股票損益率",
     "已實現總損益", "已實現總損益率",
     "已實現股票損益", "利息與股息", "什支", "其他",
     "持倉成本", "持倉市值",
     "可用現金", "定存"],
    rows
  );
}

function writePortfolioStatus(ss, p) {
  writeState(ss, CONFIG.OUTPUT.PORTFOLIO_STATUS,
    ["總資本", "持倉成本", "已實現損益", "利息與股息", "定存", "可用現金", "持倉市值", "總資產", "未實現損益", "總損益", "總報酬率", "股票倉位", "現金倉位"],
    [[p.capital, p.invested, p.realizedPnL, p.interest, p.deposit, p.cash, p.marketValue, p.totalAssets, p.unrealizedPnL, p.totalPnL, p.totalReturn, p.equityWeight, p.cashWeight]]
  );
}

// ----- 計算定存狀態 -----
// 從定存事件表配對存入/到期，產生定存狀態表
function calcDepositStatus(ss) {
  var depositEvents = readSheet(ss, CONFIG.SOURCE.DEPOSIT_EVENTS);
  if (!depositEvents) return;

  var deposits = [];   // 所有存入事件
  var maturities = {}; // 到期事件的 lookup

  for (var i = 0; i < depositEvents.data.length; i++) {
    var row = depositEvents.data[i];
    var direction = String(row[depositEvents.col("方向")]).trim();
    var bank = String(row[depositEvents.col("銀行")]).trim();
    var account = String(row[depositEvents.col("帳戶名")]).trim();
    var currency = String(row[depositEvents.col("幣別")]).trim();
    var amount = Math.abs(Number(row[depositEvents.col("金額")]));
    var days = Number(row[depositEvents.col("天數")]) || 0;
    var rawRate = row[depositEvents.col("年利率")];
    var rateNum, rateStr;
    if (typeof rawRate === "number") {
      // Google Sheets 百分比格式：1% 存為 0.01
      rateNum = rawRate;
      rateStr = (rawRate * 100) + "%";
    } else {
      // 字串格式："1%" 或 "1"
      var cleaned = String(rawRate).replace("%", "").trim();
      rateNum = Number(cleaned) / 100 || 0;
      rateStr = cleaned + "%";
    }
    var date = row[depositEvents.col("日期")];
    var maturityDate = row[depositEvents.col("到期日")];

    if (direction === "存入") {
      deposits.push({
        bank: bank, account: account, currency: currency,
        amount: amount, days: days, rate: rateNum, rateStr: rateStr,
        startDate: date, maturityDate: maturityDate,
        matured: false
      });
    } else if (direction === "到期") {
      // 用 銀行+帳戶+幣別+金額+到期日 作為配對 key
      var mDate = maturityDate instanceof Date ? maturityDate.getTime() : new Date(maturityDate).getTime();
      var key = bank + "|" + account + "|" + currency + "|" + amount + "|" + mDate;
      maturities[key] = true;
    }
  }

  // 配對：標記已到期的存入
  var today = new Date();
  for (var i = 0; i < deposits.length; i++) {
    var d = deposits[i];
    var mDate = d.maturityDate instanceof Date ? d.maturityDate.getTime() : new Date(d.maturityDate).getTime();
    var key = d.bank + "|" + d.account + "|" + d.currency + "|" + d.amount + "|" + mDate;
    if (maturities[key]) {
      d.matured = true;
      delete maturities[key]; // 一對一消耗
    } else if (d.maturityDate instanceof Date && d.maturityDate <= today) {
      d.matured = true; // 到期日已過但沒有到期事件
    } else if (!(d.maturityDate instanceof Date) && new Date(d.maturityDate) <= today) {
      d.matured = true;
    }
  }

  // 計算利息
  var rows = [];
  for (var i = 0; i < deposits.length; i++) {
    var d = deposits[i];
    var estimatedInterest = Math.round(d.amount * d.rate * d.days / 360 * 100) / 100;
    var status = d.matured ? "已到期" : "持有中";
    var realizedInterest = d.matured ? estimatedInterest : 0;

    rows.push([
      d.bank, d.account, d.currency,
      d.amount, d.startDate, d.maturityDate,
      d.rateStr, d.days, estimatedInterest, status, realizedInterest
    ]);
  }

  // 排序：持有中在前，已到期在後；同狀態按到期日排
  rows.sort(function(a, b) {
    if (a[9] !== b[9]) return a[9] === "持有中" ? -1 : 1;
    return new Date(a[5]) - new Date(b[5]);
  });

  writeState(ss, CONFIG.OUTPUT.DEPOSIT_STATUS,
    ["銀行", "帳戶名", "幣別", "金額", "起始日", "到期日", "年利率", "天數", "預估利息", "狀態", "已實現利息"],
    rows
  );
}

// =============================================================================
// 輔助函數
// =============================================================================

// 讀取工作表，回傳 { headers, data, col(name) }
function readSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  return {
    headers: headers,
    data: data,
    col: function(name) { return headers.indexOf(name); }
  };
}

// 寫入狀態表（清除舊資料 → 寫入標題 → 寫入資料）
// ===== DEBUG：診斷分割/反分割計算 =====
function debugSplitCalc() {
  var ss = SpreadsheetApp.openById("1_gy-srj_7ejRyEPt_b51dovt_Ka8caAyN9E6nEYxPF4");
  var trades = readSheet(ss, "股票事件表");
  if (!trades) { Logger.log("找不到股票事件表"); return; }

  // 印出欄位列表
  Logger.log("=== 股票事件表欄位 ===");
  Logger.log(trades.headers.join(" | "));

  var splitCol = trades.col("分割/反分割後新股");
  Logger.log("分割/反分割後新股 欄位 index = " + splitCol);

  // 找出所有方向含「分割」的記錄
  Logger.log("=== 分割/反分割 記錄 ===");
  for (var i = 0; i < trades.data.length; i++) {
    var row = trades.data[i];
    var dir = String(row[trades.col("方向")]);
    if (dir.indexOf("分割") >= 0 || dir.indexOf("合併") >= 0) {
      var splitQty = splitCol >= 0 ? row[splitCol] : "（欄位不存在）";
      Logger.log("row " + (i+2) + " | Ticker=" + row[trades.col("Ticker")] +
        " | 方向=" + dir + " | 股數=" + row[trades.col("股數")] +
        " | 分割後新股欄值=" + splitQty);
    }
  }
}

function writeState(ss, sheetName, headers, rows) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;

  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}
