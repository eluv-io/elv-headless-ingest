const {Ingest} = require("./src/Ingest");

const Test = async () => {
  try {
    const ingestClient = await Ingest.Initialize({
      networkName: "demo",
      privateKey: process.env.PRIVATE_KEY
    });

    const libraryId = "";
    const contentType = "";
    const filePaths = [""];
    const title = "";

    await ingestClient.IngestMedia({
      libraryId,
      contentType,
      files: filePaths,
      title
    });
  } catch(error) {
    console.error(error);
    console.error(JSON.stringify(error, null, 2));
  }

  process.exit(0);
};

Test();
