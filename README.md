# elv-headless-ingest

A sample application designed to demonstrate ingesting capabilities of the Eluvio Content Fabric.

## Installation

#### Install from NPM:

```
npm install --save @eluvio/elv-headless-ingest
```
### Ingest Process Internals

NOTE: For a more comprehensive guide to ingesting media onto the Fabric, please refer to the following guide: https://eluv-io.github.io/elv-client-js/abr/index.html.

#### Overview

Creating a playable media object involves the following steps:
* **Create a Production Master object** - the master object holds copies of the original source file(s) and/or links to source files stored in S3. It is not directly playable, but is used to generate a playable Mezzanine object.
* **Upload file(s) to Master (or add links to S3 files)** - for files that are on S3, you can either copy the files into the fabric or just use a reference link to S3.
* **Create an ABR Profile** - the ABR (Adjustable BitRate) profile holds settings for generating the final playable object such as resolution, bitrate, and DRM options.
* **Create a Mezzanine object** - the mezzanine object holds the playable media that has been transcoded and optimized for low latency playback.
* **Start transcode job(s)** - each job transcodes one stream in the final mezzanine.
* **Monitor job status and finalize mezzanine when finished** - After all transcodes have finished, finalizing the mezzanine populates metadata needed for playback, then publishes the object to make it accessible.

#### Details

Each step above consists of a number of smaller steps that call various functions in [elv-client-js](https://github.com/eluv-io/elv-client-js) and [elv-abr-profile](https://github.com/eluv-io/elv-abr-profile):

* **Create a Production Master**
    * Create object (`ElvClient.CreateProductionMaster()`)
    * Upload file(s) (`ElvClient.UploadFiles()` or `ElvClient.UploadFilesFromS3()`)
    * Encrypt object (`ElvClient.CreateEncryptionConk()`)
* **Create an ABR Profile**
    * Get variant and sources metadata. This may come from the Production Master metadata, illustrated below:
  ```
  ElvClient.ContentObjectMetadata({
  select: [
    "production_master/sources",
    "production_master/variants/default"
    ]
  })
  ```
    * Generate an ABR Profile based on the above sources and default variant as well as optional ABR profile and standard aspect ratios (`ABR.ABRPorfileForVariant(sources, variant, abr, standardAspectRatios)`)
* **Create a Mezzanine object**
    * Edit or Create object (`ElvClient.EditContentObject()` or `ElvClient.CreateContentObject()`)
    * Encrypt object (`ElvClient.CreateEncryptionConk()`)
* **Start transcode job(s)**
    * Start jobs (`ElvClient.StartABRMezzanineJobs()`)
* **Monitor job status and finalize mezzanine when finished**
    * Poll job status until complete (`ElvClient.LROStatus()`)
    * Finalize (`ElvClient.FinalizeABRMezzanine()`)
