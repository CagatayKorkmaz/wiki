require('dotenv').config();
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function test() {
  try {
    console.log("Database fetchleniyor...");
    const metadata = await notion.databases.retrieve({ database_id: process.env.NOTION_DATABASE_ID });
    console.log("Database mülkiyetleri (Properties):");
    console.log(Object.keys(metadata.properties).join(", "));
    
    console.log("\nSorgu yapılıyor...");
    const res = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID,
      filter: {
          or: [
            { property: "Status", status: { equals: "Kamu" } },
            { property: "Status", select: { equals: "Kamu" } }
          ]
      }
    });
    console.log("BAŞARILI! Bulunan sayfa sayısı:", res.results.length);
  } catch(e) {
    console.error("HATA:", e.message);
  }
}
test();
