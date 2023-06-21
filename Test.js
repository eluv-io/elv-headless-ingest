const { ElvClient } = require("@eluvio/elv-client-js");

const Test = async () => {
  try {
    const client = await ElvClient.FromNetworkName({
      networkName: "demo" // "main" | "demo" | "test"
    });

    const wallet = client.GenerateWallet();
    const signer = wallet.AddAccount({
      privateKey: process.env.PRIVATE_KEY
    });

    client.SetSigner({signer});
  } catch(error) {
    console.error(error);
    console.error(JSON.stringify(error, null, 2));
  }

  process.exit(0);
};

Test();
