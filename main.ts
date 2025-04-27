import { serveFile } from "jsr:@std/http@1/file-server";
import { pooledMap } from "jsr:@std/async@1/pool";
import { range } from "jsr:@alg/range@0.0.4";

async function updateStats() {
  const PACKAGES_API = "https://api.jsr.io/packages";
  const PACKAGE_DOWNLOAD_API =
    "https://api.jsr.io/scopes/${SCOPE}/packages/${NAME}/downloads";

  const pkgs: { scope: string; name: string; count: number }[] = [];
  const writeID = setInterval(
    async () =>
      await Deno.writeTextFile(
        "packages-count.json",
        JSON.stringify(pkgs, null, 2),
      ),
    5000,
  );
  let done = 0;
  const now = performance.now();
  await Array.fromAsync(
    pooledMap(10, range(1, 114), async (page: number) => {
      const packages: {
        items: { scope: string; name: string }[];
        total: number;
      } = await fetch(
        PACKAGES_API + `?page=${page}`,
      ).then((r) => r.json());

      await Array.fromAsync(
        pooledMap(90, packages.items.entries(), async ([_idx, pkg]) => {
          const scope = pkg.scope;
          const name = pkg.name;
          const stats: { total: [{ count: number }] } = await fetch(
            PACKAGE_DOWNLOAD_API.replace("${SCOPE}", scope).replace(
              "${NAME}",
              name,
            ),
          ).then((r) => r.json());
          const count = stats.total.map((item) => item.count).reduce(
            (acc, curr) => acc + curr,
            0,
          );
          done++;
          console.log(`[${done}/${packages.total}]`, { scope, name, count });
          pkgs.push({ scope, name, count });
        }),
      );
    }),
  );
  console.log("Time taken:", performance.now() - now);
  clearInterval(writeID);
  pkgs.sort((a, b) => b.count - a.count);
  Deno.writeTextFileSync("packages-count.json", JSON.stringify(pkgs, null, 2));
}

if (import.meta.main) {
  console.log("Cron job started, updating stats every day");
  Deno.cron("update stats", "0 0 * * *", async () => {
    await updateStats();
  });

  Deno.serve((req) => {
    const url = req.url;
    const path = new URL(url).pathname;
    if (path === "/") {
      return serveFile(req, "index.html");
    }
    return serveFile(req, path.slice(1)); // remove leading slash
  });
}
