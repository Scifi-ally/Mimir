# India Market Research Notes

## Primary and academic sources gathered

1. SEBI, **Updated SEBI Study Reveals 93% of Individual Traders Incurred Losses in Equity F&O between FY22 and FY24; Aggregate Losses Exceed ₹1.8 Lakh Crores Over Three Years**, 23 Sep 2024. URL: https://www.sebi.gov.in/media-and-notifications/press-releases/sep-2024/updated-sebi-study-reveals-93-of-individual-traders-incurred-losses-in-equity-fando-between-fy22-and-fy24-aggregate-losses-exceed-1-8-lakh-crores-over-three-years_86906.html. Search/browser extraction confirms the official title/date and links to the SEBI study PDF. Use as evidence that retail F&O behavior is a poor template for professional signal construction and that costs/turnover/selection discipline matter.

2. SEBI, **Study - Analysis of Profit and Loss of Individual Traders dealing in Equity F&O Segment**, 25 Jan 2023. URL: https://www.sebi.gov.in/reports-and-statistics/research/jan-2023/study-analysis-of-profit-and-loss-of-individual-traders-dealing-in-equity-fando-segment_67525.html. Official research landing page; includes SEBI data-sharing and FPI statistics navigation.

3. NSE, **FII/FPI & DII trading activity in Capital Market segment**. URL: https://www.nseindia.com/reports/fii-dii. Search result describes NSE-compiled activity across BSE, NSE, and MSEI. Candidate data source for daily net buy/sell, rolling flow, flow breadth, and price/flow divergence features.

4. NSE, **All Reports - Equities, Indices, Mutual Fund, Securities ...**. URL: https://www.nseindia.com/all-reports-derivatives. Search result indicates real-time, delayed, snapshot, historical, and derivatives market-data products.

5. NSE, **Daily Market Reports - Derivative Market**. URL: https://www.nseindia.com/resources/historical-reports-capital-market-daily-monthly-archives-derivative-market. Candidate source for daily derivative reports and historical contract statistics.

6. NSE, **All Reports - Equities, Indices, Mutual Fund, Securities ...**. URL: https://www.nseindia.com/all-reports. Search result lists historical index data, India VIX historical data, archives, P/E, P/B, dividend yield, and total-return index values.

7. BSE, **Market Data Products**. URL: https://www.bseindia.com/marketdata-products. Search result describes real-time, delayed, end-of-day, historical, and corporate data products.

8. BSE, **Historical Information**. URL: https://www.bseindia.com/static/markets/market_data. Search result lists gross deliverables, bulk deals, block deals, and margin-trading information.

9. BSE, **Corporate Actions / Corporate Announcements**. URLs: https://www.bseindia.com/corporates/corporates_act and https://www.bseindia.com/corporates. Candidate sources for ex-date, dividends, splits, rights, results, bulk deals, and announcements.

10. RBI, **Database of Indian Economy (DBIE)**. URL: https://data.rbi.org.in/DBIE/. Candidate source for INR, rates, liquidity, balance-of-payments, banking, and macro series.

11. RBI, **Government Securities Market in India - A Primer**. URL: https://www.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=711. Search result confirms FPI participation in G-Secs within prescribed limits; relevant for rate/foreign-flow transmission features.

12. IMF, **Foreign Exchange Intervention Under the Integrated Policy Framework: India**, 15 Nov 2024. URL: https://www.elibrary.imf.org/view/journals/001/2024/236/article-A001-en.xml. Search result states RBI intervention affects USD/INR returns and reduces exchange-rate volatility; relevant to INR-volatility/regime features.

13. Krishnan et al., **Intraday liquidity patterns in Indian stock market**, ScienceDirect. URL: https://www.sciencedirect.com/science/article/pii/S1049007813000596. Search result states the study analyzes intraday NSE liquidity patterns using intraday data; relevant to time-of-day spread/volume/impact features.

14. **Commonality in liquidity: Evidence from India's national stock exchange**, ScienceDirect. URL: https://www.sciencedirect.com/science/article/pii/S1049007817303147. Search result identifies commonality in liquidity as a relevant NSE market-microstructure phenomenon.

15. Jain, Mishra, Tantri, **How Do Small Investors Impact Derivative Markets? Evidence from a Policy Experiment**, 2017. URL: https://www.stern.nyu.edu/sites/default/files/assets/documents/Jain_Mishra_Tantri_2017%20-%20How%20Do%20Small%20Investors%20Impact%20Derivatives%20Markets_%20Evidence%20from%20a%20Policy%20Experiment.pdf. Search result indicates entry of small investors affects stock and derivative-market valuation; relevant to participant-composition and crowding features.

## Initial evidence-to-feature implications

- Build features from India-native market data first: NSE/BSE breadth, India VIX, FII/FPI/DII flows, participant-wise futures open interest, option-chain positioning, delivery/volume, spreads, impact, circuit limits, corporate actions, earnings, and sector/index relationships.
- International variables should enter only through observed Indian transmission channels: USD/INR, Brent, US 2Y/10Y yields, DXY, VIX, S&P/Nasdaq futures, Asian session returns, and US/India rate differentials. Use lagged, point-in-time features and interaction terms rather than treating global moves as direct standalone buy/sell signals.
- Professional-quality features must be measurable as levels, changes, percentiles, shocks, persistence, divergence, and conditional responses by regime. Every feature needs a timestamp, source, publication latency, and as-of value to prevent look-ahead leakage.
- Avoid copying retail F&O behavior as a signal. The evidence supports using participant composition, crowding, liquidity, and cost-aware execution as risk/selection variables rather than blindly interpreting high retail activity as bullish or bearish.
