import { WebSocket } from 'ws';

function generateRandomTick(symbol: string) {
  const basePrice = Math.random() * 2000 + 100;
  return {
    symbol,
    price: basePrice + (Math.random() - 0.5) * 5,
    changePct: (Math.random() - 0.5) * 2,
  };
}

const symbols = Array.from({ length: 100 }, (_, i) => `NSE_EQ:SYMBOL${i}`);

async function runLoadTest() {
  console.log("Starting Load Test...");
  const ws = new WebSocket('ws://localhost:3000/ws/market-data');
  
  ws.on('open', () => {
    console.log("Connected to Market Data WebSocket");
    
    // Simulate 500 ticks/sec
    setInterval(() => {
      const batch = [];
      for(let i=0; i<10; i++) {
        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        batch.push(generateRandomTick(symbol));
      }
      ws.send(JSON.stringify({ event: 'tick_update', data: batch }));
    }, 20); // 50 times a second * 10 ticks = 500 ticks/sec
  });
  
  ws.on('close', () => console.log("Connection closed"));
  ws.on('error', console.error);
}

runLoadTest().catch(console.error);
