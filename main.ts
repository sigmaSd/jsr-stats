import { serveFile } from "jsr:@std/http@1/file-server";
import { pooledMap } from "jsr:@std/async@1/pool";
import { range } from "jsr:@alg/range@0.0.4";

async function updateStats(kv: Deno.Kv) {
  const PACKAGES_API = "https://api.jsr.io/packages";
  const PACKAGE_DOWNLOAD_API =
    "https://api.jsr.io/scopes/${SCOPE}/packages/${NAME}/downloads";
  const PACKAGE_INFO_API =
    "https://api.jsr.io/scopes/${SCOPE}/packages/${NAME}";

  // initial requests to guess pages count
  const pages = await fetch(PACKAGES_API)
    .then((r) => r.json())
    .then((r) => Math.ceil(r.total / r.items.length));

  const pkgs: {
    scope: string;
    name: string;
    count: number;
    dependentCount: number;
    score: number | null;
  }[] = [];
  let done = 0;
  const now = performance.now();
  await Array.fromAsync(
    pooledMap(10, range(1, pages), async (page: number) => {
      const packages: {
        items: { scope: string; name: string; score: number }[];
        total: number;
      } = await fetch(
        PACKAGES_API + `?page=${page}`,
      ).then((r) => r.json());

      if (packages.items === undefined) {
        throw new Error("failed to get items: " + JSON.stringify(packages));
      }
      await Array.fromAsync(
        pooledMap(90, packages.items.entries(), async ([_idx, pkg]) => {
          const scope = pkg.scope;
          const name = pkg.name;
          const info = await fetch(
            PACKAGE_INFO_API
              .replace("${SCOPE}", scope)
              .replace("${NAME}", name),
          ).then((r) => r.json());
          const stats: { total: [{ count: number }] } = await fetch(
            PACKAGE_DOWNLOAD_API
              .replace("${SCOPE}", scope)
              .replace("${NAME}", name),
          ).then((r) => r.json());
          const count = stats.total.map((item) => item.count)
            .reduce((acc, curr) => acc + curr, 0);
          done++;
          console.log(`[${done}/${packages.total}]`, {
            scope,
            name,
            count,
            score: pkg.score,
            dependentCount: info.dependentCount,
          });
          pkgs.push({
            scope,
            name,
            count,
            score: pkg.score,
            dependentCount: info.dependentCount,
          });
        }),
      );
    }),
  );
  console.log("Time taken:", performance.now() - now);
  pkgs.sort((a, b) => b.count - a.count);
  // Not possible in deno deploy, lets just use Deno.KV
  // await Deno.writeTextFile(
  //   "packages-count.json",
  //   JSON.stringify(pkgs, null, 2),
  // );

  // kv have a max size 65536 per set
  // so we will split it to parts
  const chunkSize = 100;
  for (let i = 0; i < pkgs.length; i += chunkSize) {
    const chunk = pkgs.slice(i, i + chunkSize);
    await kv.set(["packages", "count", i], chunk);
  }
}

function startCronJob(kv: Deno.Kv) {
  console.log("Cron job started, updating stats every day");
  Deno.cron("update stats", "0 0 * * *", async () => {
    console.log("Updating stats...");
    await updateStats(kv);
  });
}

function startServer(kv: Deno.Kv) {
  Deno.serve(async (req) => {
    const url = req.url;
    const path = new URL(url).pathname;
    if (path === "/") {
      return serveFile(req, "index.html");
    } else if (path === "/pkgs-count") {
      const pkgs = (await Array.fromAsync(
        kv.list({ prefix: ["packages", "count"] }),
      ))
        .map(({ key: _key, value }) => {
          return value;
        })
        // deno-lint-ignore no-explicit-any
        .reduce((acc: any, curr) => acc.concat(curr), []);
      return new Response(JSON.stringify(pkgs), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return serveFile(req, path.slice(1)); // remove leading slash
  });
}

if (import.meta.main) {
  const kv = await Deno.openKv();
  startCronJob(kv);
  startServer(kv);
}
