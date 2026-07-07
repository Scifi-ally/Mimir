import pg from 'pg';

const { Client } = pg;

const client = new Client({
  connectionString: 'postgresql://postgres:qwerty@localhost:5432/upstox_bot'
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to DB");
    
    // Add trailing_stop_loss to paper_positions if not exists
    await client.query(`
      ALTER TABLE paper_positions 
      ADD COLUMN IF NOT EXISTS trailing_stop_loss numeric;
    `);
    console.log("Added trailing_stop_loss to paper_positions");

    // Create symbol_scores table
    await client.query(`
      CREATE TABLE IF NOT EXISTS symbol_scores (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        symbol varchar(20) NOT NULL,
        score numeric(5, 2) NOT NULL,
        features jsonb NOT NULL,
        for_date timestamp with time zone NOT NULL
      );
    `);
    console.log("Created symbol_scores table");
    
    // Create ai_scores table (already exists but just in case we need anything else?)
    // In our drizzle schema we added some stuff, but ai_scores was failing.
    // The previous error was: relation "ai_scores" already exists.
    
    console.log("DB fixes applied successfully");
  } catch (error) {
    console.error("DB fix error:", error);
  } finally {
    await client.end();
  }
}

run();
