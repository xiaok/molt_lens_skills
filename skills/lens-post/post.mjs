import "dotenv/config";

import { PublicClient, evmAddress, mainnet, testnet, uri } from "@lens-protocol/client";
import { fetchAccountsAvailable, post } from "@lens-protocol/client/actions";
import { handleOperationWith, signMessageWith } from "@lens-protocol/client/viem";
import { textOnly } from "@lens-protocol/metadata";
import { StorageClient, immutable } from "@lens-chain/storage-client";
import { chains } from "@lens-chain/sdk/viem";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

function parseArgs(argv) {
  const args = {
    content: null,
    contentUri: null,
    environment: "mainnet",
    origin: "https://openclaw.local",
    app: null,
    account: null,
    publish: false,
    dryRun: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case "--content":
        args.content = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--content-uri":
        args.contentUri = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--environment":
        args.environment = argv[index + 1] ?? "mainnet";
        index += 1;
        break;
      case "--origin":
        args.origin = argv[index + 1] ?? args.origin;
        index += 1;
        break;
      case "--app":
        args.app = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--account":
        args.account = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--publish":
        args.publish = true;
        args.dryRun = false;
        break;
      case "--dry-run":
        args.publish = false;
        args.dryRun = true;
        break;
      case "--help":
        return { ...args, help: true };
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printHelp() {
  const lines = [
    "Lens post helper (safe by default)",
    "",
    "Usage:",
    "  node skills/lens-post/post.mjs --dry-run --content \"hello\"",
    "  node skills/lens-post/post.mjs --publish --content \"hello\"",
    "  node skills/lens-post/post.mjs --publish --content-uri lens://...",
    "",
    "Options:",
    "  --content <text>          Text-only post content",
    "  --content-uri <uri>       Skip upload and use an existing contentUri",
    "  --environment <mainnet|testnet>",
    "  --origin <url>            Origin header for Lens login (Node needs this)",
    "  --app <0x...>             Optional Lens App address (if your login requires it)",
    "  --account <0x...>         Optional Lens Account address (auto-detected if omitted)",
    "  --dry-run                 Print what would happen (default)",
    "  --publish                 Actually broadcast the post",
    "",
    "Environment:",
    "  PRIVATE_KEY               EVM private key (hex, with or without 0x)",
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

function normalizePrivateKey(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function resolveEnvironment(name) {
  switch (name) {
    case "mainnet":
      return { lens: mainnet, chain: chains.mainnet };
    case "testnet":
      return { lens: testnet, chain: chains.testnet };
    default:
      throw new Error(`Unknown environment: ${name} (expected mainnet|testnet)`);
  }
}

async function resolveAccountAddress(client, walletAddress) {
  const result = await fetchAccountsAvailable(client, {
    managedBy: evmAddress(walletAddress),
    includeOwned: true,
  });

  if (result.isErr()) {
    throw new Error(`fetchAccountsAvailable failed: ${result.error}`);
  }

  const { items } = result.value;
  if (!items || items.length === 0) {
    throw new Error("No Lens accounts available for this wallet.");
  }

  const first = items[0];

  // The SDK returns a union of AccountOwned | AccountManaged.
  // Both include an `account.address` field.
  const address = first?.account?.address;
  if (!address) {
    throw new Error("Unexpected accounts response: missing account.address");
  }

  return address;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY);
  if (!privateKey) {
    throw new Error("Missing PRIVATE_KEY in environment (.env)");
  }

  if (!args.contentUri && !args.content) {
    throw new Error("Provide --content or --content-uri");
  }

  const { lens, chain } = resolveEnvironment(args.environment);

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  const appAddress = args.app ?? null;

  const client = PublicClient.create({
    environment: lens,
    origin: args.origin,
  });

  if (args.dryRun) {
    const metadata = args.content
      ? textOnly({ content: args.content })
      : { note: "--content-uri provided; metadata generation skipped" };

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          environment: args.environment,
          walletAddress: account.address,
          lensAccountAddress: args.account ?? null,
          app: appAddress,
          note: appAddress ? null : "No --app provided; login will omit app.",
          willUploadMetadata: Boolean(args.content && !args.contentUri),
          willPublish: false,
          metadata,
          contentUri: args.contentUri ?? null,
        },
        null,
        2,
      ),
    );

    return;
  }

  const accountAddress = args.account ?? (await resolveAccountAddress(client, account.address));

  const loginRequest = {
    accountOwner: {
      account: evmAddress(accountAddress),
      owner: account.address,
      ...(appAddress ? { app: evmAddress(appAddress) } : {}),
    },
    signMessage: signMessageWith(walletClient),
  };

  const authenticated = await client.login(loginRequest);
  if (authenticated.isErr()) {
    throw new Error(`Lens login failed: ${authenticated.error}`);
  }

  const sessionClient = authenticated.value;

  let contentUri = args.contentUri;
  if (!contentUri) {
    const storageClient = StorageClient.create();
    const metadata = textOnly({ content: args.content });
    const uploaded = await storageClient.uploadAsJson(metadata, {
      acl: immutable(chain.id),
    });
    contentUri = uploaded.uri;
  }

  const postResult = await post(sessionClient, { contentUri: uri(contentUri) });

  if (postResult.isErr()) {
    throw new Error(`Post request failed: ${postResult.error}`);
  }

  const executed = await postResult.andThen(handleOperationWith(walletClient));

  if (executed.isErr()) {
    throw new Error(`Post broadcast failed: ${executed.error}`);
  }

  const txHash = executed.value;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        txHash,
        contentUri,
      },
      null,
      2,
    ),
  );

  const indexed = await sessionClient.waitForTransaction(txHash);
  if (indexed.isErr()) {
    // Don't hide the tx hash; indexing might fail even when the tx is mined.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify(
        {
          ok: false,
          txHash,
          indexingError: String(indexed.error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ indexed: true, txHash }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
