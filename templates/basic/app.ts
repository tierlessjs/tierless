// Your Stackmix app — ordinary TypeScript. There are no tier annotations:
// placement is inferred from the resources you touch. `db.*` lives on the server,
// `ui.*` on the client. You don't split the program by hand — the runtime moves
// the live computation to wherever the next resource is.
declare const db: { products(): { name: string; price: number }[] };
declare const ui: { show(lines: string[]): number };

function main(): number {
  const products = db.products();        // server resource -> run where the data is
  const cheap = [];
  for (let i = 0; i < products.length; i = i + 1) {
    if (products[i].price < 50) {
      cheap.push(products[i].name + " ($" + products[i].price + ")");
    }
  }
  return ui.show(cheap);                  // client resource -> migrate to the client
}
