const SECTOR_RISK_MULTIPLIERS = {
  'טכנולוגיה': 1.2,
  'קריפטו': 2.0,
  'בריאות ותרופות': 0.9,
  'מוצרי צריכה': 0.8,
  'בנקאות וכספים': 1.0,
  'אנרגיה': 1.4,
  'תעשייה': 1.1,
  'נדל"ן': 0.85,
  'לא מוגדר': 1.3,
  'מוצרי צריכה בסיסיים': 0.7,
  'שירותי ציבור': 0.75,
  'תקשורת': 0.95,
  'חומרים': 1.05,
  'ETF': 0.6,
};

function calculateVolatility(prices) {
  if (!prices || prices.length < 2) return 0;
  const dailyReturns = [];
  for (let i = 1; i < prices.length; i++) {
    const dailyReturn = (prices[i] - prices[i - 1]) / prices[i - 1];
    dailyReturns.push(dailyReturn);
  }
  if (dailyReturns.length === 0) return 0;
  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const squaredDiffs = dailyReturns.map(ret => Math.pow(ret - meanReturn, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
  return Math.sqrt(variance) * 100;
}

function calculateRiskAndStopLoss(stock, priceHistory, portfolioRiskLevel = 50) {
  if (!stock || !priceHistory || priceHistory.length < 10) {
    return {
      riskScore: 5.0,
      stopLossPrice: stock.entry_price * 0.9
    };
  }

  const volatility = calculateVolatility(priceHistory);
  let volatilityScore = (volatility / 4) * 10;
  volatilityScore = Math.min(volatilityScore, 10);

  const sectorMultiplier = SECTOR_RISK_MULTIPLIERS[stock.sector] || 1.3;
  let riskScore = volatilityScore * sectorMultiplier;
  riskScore = Math.max(1, Math.min(10, riskScore));

  const baseStopLossPercentage = riskScore * 1.5;
  const portfolioRiskFactor = 1 + (portfolioRiskLevel - 50) / 100;
  const finalStopLossPercentage = baseStopLossPercentage * portfolioRiskFactor;

  const stopLossPrice = stock.entry_price * (1 - finalStopLossPercentage / 100);

  return {
    riskScore: parseFloat(riskScore.toFixed(2)),
    stopLossPrice: parseFloat(stopLossPrice.toFixed(2))
  };
}

module.exports = { calculateRiskAndStopLoss };
