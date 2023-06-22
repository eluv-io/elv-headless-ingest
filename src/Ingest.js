const Path = require("path");
const {ElvClient} = require("@eluvio/elv-client-js");
const {ValidateLibrary} = require("@eluvio/elv-client-js/src/Validation");
const {DrmPublicProfile, DrmWidevineFairplayProfile, ReadFiles} = require("./Utils");
const ABR = require("@eluvio/elv-abr-profile");
const defaultOptions = require("@eluvio/elv-lro-status/defaultOptions");
const enhanceLROStatus = require("@eluvio/elv-lro-status/enhanceLROStatus");

class Ingest {
  client;

  constructor({
    client
  }) {
    this.client = client;
  }

  static async Initialize({networkName, privateKey}) {
    if(!["demo", "main", "test"].includes(networkName)) {
      throw Error(`Invalid network name provided ${networkName}`);
    }

    try {
      const client = await ElvClient.FromNetworkName({
        networkName
      });

      const wallet = client.GenerateWallet();
      const signer = wallet.AddAccount({
        privateKey
      });

      client.SetSigner({signer});

      return new Ingest({client});
    } catch(error) {
      console.error(error);
      console.error(JSON.stringify(error, null, 2));
    }
  }

  RestrictAbrProfile = ({playbackEncryption, abrProfile}) => {
    let abrProfileExclude;

    if(playbackEncryption === "drm-all") {
      abrProfileExclude = ABR.ProfileExcludeClear(abrProfile);
    } else if(playbackEncryption === "drm-public") {
      abrProfileExclude = DrmPublicProfile({abrProfile});
    } else if(playbackEncryption === "drm-restricted") {
      abrProfileExclude = DrmWidevineFairplayProfile({abrProfile});
    } else if(playbackEncryption === "clear") {
      abrProfileExclude = ABR.ProfileExcludeDRM(abrProfile);

      if(abrProfileExclude && abrProfileExclude.result) {
        abrProfileExclude.result.store_clear = true;
      }
    }

    return abrProfileExclude;
  };

  async IngestMedia({
    libraryId,
    contentType,
    files,
    title,
    description,
    abr,
    accessGroupAddress,
    playbackEncryption="clear",
    access=[],
    copy,
    s3Url,
    variant="default",
    offeringKey="default"
  }) {
    const createResponse = await this.CreateContentObject({
      libraryId,
      contentType,
      files
    });

    const writeToken = createResponse.write_token;
    const masterObjectId = createResponse.id;

    const prodMasterResponse = await this.CreateProductionMaster({
      libraryId,
      files,
      title,
      accessGroupAddress,
      description,
      s3Url,
      abr,
      playbackEncryption,
      access,
      copy,
      masterObjectId,
      writeToken
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    await this.WaitForPublish({
      hash: prodMasterResponse.hash,
      objectId: masterObjectId,
      libraryId
    });

    const abrMezResponse = await this.CreateABRMezzanine({
      libraryId,
      masterObjectId,
      type: contentType,
      title,
      masterVersionHash: prodMasterResponse.hash,
      abrProfile: prodMasterResponse.abrProfile,
      variant,
      offeringKey
    });

    const jobResponse = await this.StartTranscodeJob({
      libraryId,
      objectId: masterObjectId,
      access
    });

    const finalizeResponse = await this.MonitorJobStatus({
      libraryId,
      objectId: abrMezResponse.id,
      writeToken: jobResponse.writeToken,
      title,
      description,
      accessGroupAddress
    });

    return {
      id: masterObjectId,
      hash: finalizeResponse.hash
    };
  }

  WaitForPublish = async function ({hash, objectId}) {
    let publishFinished = false;
    let latestObjectHash;
    while(!publishFinished) {
      try {
        latestObjectHash = await this.client.LatestVersionHash({
          objectId
        });

        if(latestObjectHash === hash) {
          publishFinished = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, 15000));
        }
      } catch(error) {
        console.error(`Waiting for master object publishing hash:${hash}. Retrying.`, error);
        await new Promise(resolve => setTimeout(resolve, 7000));
      }
    }
  };

  CreateContentObject = async function ({
    libraryId,
    contentType,
    files=[]
  }) {
    let createResponse;
    let totalFileSize;
    try {
      if(files) {
        totalFileSize = 0;
        files.forEach(file => totalFileSize += file.size);

        if(totalFileSize === 0) {
          throw Error("The selected file(s) contain no data.");
        }
      }

      createResponse = await this.client.CreateContentObject({
        libraryId,
        options: contentType ? { type: contentType } : {}
      });

      try {
        await this.client.SetVisibility({
          id: createResponse.id,
          visibility: 0
        });

        return createResponse;
      } catch(error) {
        console.error("Unable to set visibility.", error);
      }
    } catch(error) {
      throw error;
    }
  };

  CreateABRLadder = async function ({
     libraryId,
     objectId,
     writeToken,
     abr
   }) {
    try {
      const {production_master} = await this.client.ContentObjectMetadata({
        libraryId,
        objectId,
        writeToken,
        select: [
          "production_master/sources",
          "production_master/variants/default"
        ]
      });

      if(!production_master || !production_master.sources || !production_master.variants || !production_master.variants.default) {
        throw Error("Unable to create ABR profile.");
      }

      const generatedProfile = ABR.ABRProfileForVariant(
        production_master.sources,
        production_master.variants.default,
        abr ? abr.default_profile : undefined
      );

      if(!generatedProfile.ok) {
        throw Error("Unable to create ABR profile.");
      }

      return {
        abrProfile: generatedProfile.result
      };
    } catch(error) {
      throw error;
    }
  };

  CreateProductionMaster = async function ({
    libraryId,
    files,
    title,
    accessGroupAddress,
    description,
    s3Url,
    abr,
    playbackEncryption,
    access,
    copy,
    masterObjectId,
    writeToken
   }) {
    ValidateLibrary(libraryId);

    // Create encryption conk
    try {
      await this.client.CreateEncryptionConk({
        libraryId: libraryId,
        objectId: masterObjectId,
        writeToken,
        createKMSConk: true
      });
    } catch(error) {
      throw error;
    }

    try {
      const UploadCallback = (progress) => {
        let uploadSum = 0;
        let totalSum = 0;
        Object.values(progress).forEach(fileProgress => {
          uploadSum += fileProgress.uploaded;
          totalSum += fileProgress.total;
        });
      };

      // Upload files
      if(access.length > 0) {
        const s3Reference = access[0];
        const region = s3Reference.remote_access.storage_endpoint.region;
        const bucket = s3Reference.remote_access.path.replace(/\/$/, "");
        const accessKey = s3Reference.remote_access.cloud_credentials.access_key_id;
        const secret = s3Reference.remote_access.cloud_credentials.secret_access_key;
        const signedUrl = s3Reference.remote_access.cloud_credentials.signed_url;
        const baseName = decodeURIComponent(Path.basename(
          s3Url ? s3Url : signedUrl.split("?")[0]
        ));
        // should be full path when using AK/Secret
        const source = s3Url ? s3Url : baseName;

        await this.client.UploadFilesFromS3({
          libraryId,
          objectId: masterObjectId,
          writeToken,
          fileInfo: [{
            path: baseName,
            source
          }],
          region,
          bucket,
          accessKey,
          secret,
          signedUrl,
          copy,
          encryption: "cgck"
        });
      } else {
        const fileInfo = ReadFiles(files);

        await this.client.UploadFiles({
          libraryId,
          objectId: masterObjectId,
          writeToken,
          fileInfo,
          callback: UploadCallback,
          encryption: "cgck"
        });
      }
    } catch(error) {
      throw error;
    }

    // Bitcode method
    let logs;
    let warnings;
    let errors;

    try {
      const response = await this.client.CallBitcodeMethod({
        libraryId,
        objectId: masterObjectId,
        writeToken: writeToken,
        method: "media/production_master/init",
        body: {
          access
        },
        constant: false
      });

      logs = response.logs;
      warnings = response.warnings;
      errors = response.errors;

      if(errors && errors.length) {
        throw Error("Unable to get media information from production master.");
      }
    } catch(error) {
      throw error;
    }

    // Check for audio and video streams
    try {
      const streams = (await this.client.ContentObjectMetadata({
        libraryId,
        objectId: masterObjectId,
        writeToken,
        metadataSubtree: "production_master/variants/default/streams"
      }));

      let unsupportedStreams = [];
      if(!streams.audio) { unsupportedStreams.push("audio"); }
      if(!streams.video) { unsupportedStreams.push("video"); }

      if(unsupportedStreams.length > 0) {
        console.log(`No suitable ${unsupportedStreams.join(", ")} streams found in the media file.`);
      }
    } catch(error) {
      throw error;
    }

    // Merge metadata
    try {
      await this.client.MergeMetadata({
        libraryId,
        objectId: masterObjectId,
        writeToken,
        metadata: {
          public: {
            name: `${title} [ingest: uploading] MASTER`,
            description,
            asset_metadata: {
              display_title: `${title} [ingest: uploading] MASTER`
            }
          },
          reference: true,
          elv_created_at: new Date().getTime()
        },
      });
    } catch(error) {
      throw error;
    }

    // Create ABR Ladder
    let {abrProfile} = await this.CreateABRLadder({
      libraryId,
      objectId: masterObjectId,
      writeToken,
      abr
    });

    // Update name to remove [ingest: uploading]
    try {
      await this.client.MergeMetadata({
        libraryId,
        objectId: masterObjectId,
        writeToken,
        metadata: {
          public: {
            name: `${title} MASTER`,
            description,
            asset_metadata: {
              display_title: `${title} MASTER`
            }
          },
          reference: true,
          elv_created_at: new Date().getTime()
        },
      });
    } catch(error) {
      throw error;
    }

    // Finalize object
    let finalizeResponse;
    try {
      finalizeResponse = await this.client.FinalizeContentObject({
        libraryId,
        objectId: masterObjectId,
        writeToken,
        commitMessage: "Create master object",
        awaitCommitConfirmation: false
      });
    } catch(error) {
      throw error;
    }

    if(accessGroupAddress) {
      try {
        await this.client.AddContentObjectGroupPermission({objectId: masterObjectId, groupAddress: accessGroupAddress, permission: "manage"});
      } catch(error) {
        throw error;
      }
    }

    if(playbackEncryption !== "custom") {
      let abrProfileExclude = this.RestrictAbrProfile({playbackEncryption, abrProfile});

      if(abrProfileExclude.ok) {
        abrProfile = abrProfileExclude.result;
      } else {
        throw Error("ABR Profile has no relevant playout formats.");
      }
    }

    return Object.assign(
      finalizeResponse, {
        abrProfile,
        access,
        errors: errors || [],
        logs: logs || [],
        warnings: warnings || []
      }
    );
  };

  CreateABRMezzanine = async function ({
    libraryId,
    masterObjectId,
    type,
    title,
    masterVersionHash,
    abrProfile,
    variant,
    offeringKey
  }) {
    const newObject = !masterObjectId;

    try {
      const createResponse = await this.client.CreateABRMezzanine({
        libraryId,
        objectId: newObject ? undefined : masterObjectId,
        type,
        name: `${title} [ingest: transcoding] MEZ`,
        masterVersionHash,
        abrProfile,
        variant,
        offeringKey
      });

      await this.WaitForPublish({
        hash: createResponse.hash,
        objectId: masterObjectId,
        libraryId
      });

      return createResponse;
    } catch(error) {
      throw error;
    }
  };

  StartTranscodeJob = async function ({
    libraryId,
    objectId,
    access
  }) {
    let hash;
    let response;
    try {
      response = await this.client.StartABRMezzanineJobs({
        libraryId,
        objectId,
        access
      });

      hash = response.hash;
    } catch(error) {
      throw error;
    }

    await this.WaitForPublish({
      hash,
      libraryId,
      objectId
    });

    return response;
  };

  MonitorJobStatus = async function ({
    libraryId,
    objectId,
    title,
    description,
    writeToken,
    accessGroupAddress
  }) {
    let done;
    let errorState;
    let statusIntervalId;
    let finalizeResponse;
    while(!done && !errorState) {
      let status;
      try {
        status = await this.client.LROStatus({
          libraryId,
          objectId
        });
      } catch(error) {
        errorState = true;
        if(statusIntervalId) clearInterval(statusIntervalId);

        throw error;
      }

      if(status === undefined) {
        errorState = true;
        if(statusIntervalId) clearInterval(statusIntervalId);

        throw Error("Received no job status information from server.");
      }

      if(statusIntervalId) clearInterval(statusIntervalId);
      statusIntervalId = setInterval( async () => {
        const options = Object.assign(
          defaultOptions(),
          {currentTime: new Date()}
        );
        const enhancedStatus = enhanceLROStatus(options, status);

        if(!enhancedStatus.ok) {
          clearInterval(statusIntervalId);
          errorState = true;

          throw Error("Unable to transcode selected file.");
        }

        const {estimated_time_left_seconds, estimated_time_left_h_m_s, run_state} = enhancedStatus.result.summary;

        if(run_state !== "running") {
          clearInterval(statusIntervalId);
          done = true;

          try {
            await this.client.MergeMetadata({
              libraryId,
              objectId,
              writeToken,
              metadata: {
                public: {
                  name: `${title} MEZ`,
                  description,
                  asset_metadata: {
                    display_title: `${title} MEZ`,
                  }
                }
              }
            });
          } catch(error) {
            clearInterval(statusIntervalId);
            errorState = true;

            throw error;
          }

          finalizeResponse = await this.FinalizeABRMezzanine({
            libraryId,
            objectId
          });

          if(accessGroupAddress) {
            try {
              await this.client.AddContentObjectGroupPermission({objectId, groupAddress: accessGroupAddress, permission: "manage"});
            } catch(error) {
              clearInterval(statusIntervalId);
              errorState = true;

              throw error;
            }
          }
        }
      }, 1000);

      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    return finalizeResponse;
  };


  FinalizeABRMezzanine = async function ({libraryId, objectId}) {
    try {
      const response = await this.client.FinalizeABRMezzanine({
        libraryId,
        objectId
      });

      return response;
    } catch(error) {
      throw error;
    }
  };
}

exports.Ingest = Ingest;
