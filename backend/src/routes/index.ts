import { Router, type IRouter } from "express";
import healthRouter from "./health";
import suggestionsRouter from "./suggestions";
import marketCoreRouter from "./market_core";
import marketQuotesRouter from "./market_quotes";
import marketHistoryRouter from "./market_history";
import marketAnalyticsRouter from "./market_analytics";
import watchlistRouter from "./watchlist";
import configRouter from "./config";
import { reportsRouter } from "./reports";
import { benchmarkRouter } from "./benchmark";
import systemRouter from "./system";
import paperTradingRouter from "./paper_trading";
import alertsRouter from "./alerts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(suggestionsRouter);
router.use(marketCoreRouter);
router.use(marketQuotesRouter);
router.use(marketHistoryRouter);
router.use(marketAnalyticsRouter);
router.use(watchlistRouter);
router.use(configRouter);
router.use(systemRouter);
router.use(paperTradingRouter);
router.use(alertsRouter);
router.use("/reports", reportsRouter);
router.use("/benchmark", benchmarkRouter);

export default router;
