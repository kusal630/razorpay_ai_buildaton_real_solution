import { SellableBuyer } from "./index.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const merchantUrl = args.find((a) => a.startsWith("--merchant="))?.split("=")[1];
  const apiKey = args.find((a) => a.startsWith("--key="))?.split("=")[1];
  const budget = args.find((a) => a.startsWith("--budget="))?.split("=")[1];
  const yes = args.includes("--yes");

  if (!merchantUrl || !apiKey) {
    console.error("Usage: sellable-buyer <command> --merchant=<url> --key=<api-key> [--budget=<paise>] [--yes]");
    process.exit(1);
  }

  const buyer = new SellableBuyer(merchantUrl, apiKey);

  switch (command) {
    case "discover": {
      const doc = await buyer.discover();
      console.log(JSON.stringify(doc, null, 2));
      break;
    }
    case "catalog": {
      const items = await buyer.catalog();
      console.log(JSON.stringify(items, null, 2));
      break;
    }
    case "quote": {
      const items = JSON.parse(args.find((a) => a.startsWith("--items="))?.split("=")[1] || "[]");
      const quote = await buyer.quote(items, budget ? parseInt(budget) : undefined);
      console.log(JSON.stringify(quote, null, 2));
      break;
    }
    case "buy": {
      const items = JSON.parse(args.find((a) => a.startsWith("--items="))?.split("=")[1] || "[]");
      const quote = await buyer.quote(items, budget ? parseInt(budget) : undefined);
      console.log("Quote:", JSON.stringify(quote, null, 2));

      if (!yes) {
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) =>
          rl.question("Proceed with purchase? (y/N): ", resolve)
        );
        rl.close();
        if (answer.toLowerCase() !== "y") {
          console.log("Aborted.");
          process.exit(0);
        }
      }

      const intent = await buyer.purchaseIntent(quote.quote_id, quote.hold_token);
      console.log("Payment URL:", intent.payment_url);
      console.log("Open this URL in a browser to complete payment.");
      break;
    }
    default:
      console.error("Commands: discover, catalog, quote, buy");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
