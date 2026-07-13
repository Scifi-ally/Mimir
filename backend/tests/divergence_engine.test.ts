import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeFiiDiiDivergence } from "../src/analysis/divergence_engine";
import yahooFinance from "yahoo-finance2";
import { db } from "../../db/src";

vi.mock("yahoo-finance2", () => {
  return {
    default: {
      historical: vi.fn()
    }
  };
});

vi.mock("../db/src", () => {
  const limitMock = vi.fn();
  const orderByMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  
  return {
    db: {
      select: selectMock
    }
  };
});

// Since the module is mocked, we can just grab the limitMock from db.select().from().orderBy().limit
const getLimitMock = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (db.select().from({} as any).orderBy({} as any) as any).limit;
};

describe("Divergence Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should flag bullish divergence when Nifty falls but FII/DII buys heavily", async () => {
    // 5-day flow: 2500 Cr (Bullish)
    const limitMock = getLimitMock();
    limitMock.mockResolvedValue([
      { fiiNet: 500, diiNet: 500 },
      { fiiNet: 500, diiNet: -250 },
      { fiiNet: 200, diiNet: 200 },
      { fiiNet: 800, diiNet: 0 },
      { fiiNet: 50, diiNet: 0 }
    ]); // Total = 500+500+500-250+200+200+800+0+50+0 = 2500 Cr

    // Nifty returns: falls by 2%
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (yahooFinance.historical as any).mockResolvedValue([
      { close: 20000 },
      { close: 19900 },
      { close: 19800 },
      { close: 19700 },
      { close: 19600 } // 19600/20000 - 1 = -2%
    ]);

    const result = await computeFiiDiiDivergence();
    
    expect(result.totalFlow5d).toBe(2500);
    expect(result.niftyReturn5d).toBeCloseTo(-2.0);
    expect(result.isDiverging).toBe(true);
    expect(result.divergenceType).toBe("BULLISH");
    expect(result.penaltyOrBoost).toBe(10);
  });

  it("should flag bearish divergence when Nifty rallies but FII/DII sells heavily", async () => {
    // 5-day flow: -2500 Cr (Bearish)
    const limitMock = getLimitMock();
    limitMock.mockResolvedValue([
      { fiiNet: -1000, diiNet: -500 },
      { fiiNet: -500, diiNet: 0 },
      { fiiNet: -500, diiNet: 0 },
      { fiiNet: 0, diiNet: 0 },
      { fiiNet: 0, diiNet: 0 }
    ]);

    // Nifty returns: rallies by 2%
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (yahooFinance.historical as any).mockResolvedValue([
      { close: 20000 },
      { close: 20100 },
      { close: 20200 },
      { close: 20300 },
      { close: 20400 } // 20400/20000 - 1 = +2%
    ]);

    const result = await computeFiiDiiDivergence();
    
    expect(result.totalFlow5d).toBe(-2500);
    expect(result.niftyReturn5d).toBeCloseTo(2.0);
    expect(result.isDiverging).toBe(true);
    expect(result.divergenceType).toBe("BEARISH");
    expect(result.penaltyOrBoost).toBe(-10);
  });
});
