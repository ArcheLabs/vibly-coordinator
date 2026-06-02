import process from "node:process";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

type Command = "generate" | "inspect";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "generate" && command !== "inspect") {
    printUsage();
    process.exit(1);
  }

  await cryptoWaitReady();

  if (command === "generate") {
    const uri = readNamedArg(args, "--uri") ?? mnemonicGenerate();
    printPublisher(uri);
    return;
  }

  const uri = readNamedArg(args, "--uri") ?? process.env.GET_VIB_ROOT_PUBLISHER_URI;
  if (!uri) {
    console.error("Missing publisher URI. Pass --uri '<mnemonic or derivation URI>' or set GET_VIB_ROOT_PUBLISHER_URI.");
    process.exit(1);
  }
  printPublisher(uri);
}

function printPublisher(uri: string) {
  const pair = new Keyring({ type: "sr25519" }).addFromUri(uri);
  const publicKey = `0x${Buffer.from(pair.publicKey).toString("hex")}`;

  console.log(JSON.stringify({
    uri,
    address: pair.address,
    publicKey,
    env: `GET_VIB_ROOT_PUBLISHER_URI=${shellEscape(uri)}`,
  }, null, 2));
}

function readNamedArg(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return args[index + 1];
  }
  return undefined;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function printUsage() {
  console.error(
    [
      "Usage:",
      "  pnpm get-vib-root-publisher:generate",
      "  pnpm get-vib-root-publisher:inspect -- --uri '<mnemonic or derivation URI>'",
      "",
      "Commands:",
      "  generate   Generate a new sr25519 publisher mnemonic and print the derived address",
      "  inspect    Print the address/public key for an existing mnemonic or derivation URI",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
