import { Router, type IRouter } from "express";
import healthRouter from "./health";
import suggestionsRouter from "./suggestions";
import marketRouter from "./market";
import watchlistRouter from "./watchlist";
import configRouter from "./config";
import systemRouter from "./system";
import paperTradingRouter from "./paper_trading";

const router: IRouter = Router();

router.use(healthRouter);
router.use(suggestionsRouter);
router.use(marketRouter);
router.use(watchlistRouter);
router.use(configRouter);
router.use(systemRouter);
router.use(paperTradingRouter);

export default router;
