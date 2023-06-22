const defaultAbrDrmProfile = require("./profiles/abrProfileDrm.json");
const defaultAbrClearProfile = require("./profiles/abrProfileClear.json");
const defaultAbrBothProfile = require("./profiles/abrProfileBoth.json");
const {absPath} = require("@eluvio/elv-client-js/utilities/lib/helpers");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

const Utils = {
  /**
   * Manipulate ABR Profile to return only Widevine and
   * Fairplay playout formats
   * @param {Object=} abrProfile - ABR profile
   *
   * @returns {Object} - ABR Profile with the appropriate playout formats
   */
  DrmWidevineFairplayProfile: ({abrProfile={}}) => {
    if(!abrProfile.playout_formats) { abrProfile["playout_formats"] = {}; }

    const restrictedFormats = {
      "hls-fairplay": abrProfile.playout_formats["hls-fairplay"],
      "dash-widevine": abrProfile.playout_formats["dash-widevine"]
    };

    const hasPlayouts = Object.keys(restrictedFormats).some(format => abrProfile.playout_formats[format]);

    abrProfile.playout_formats = restrictedFormats;

    return {
      ok: hasPlayouts,
      result: abrProfile
    };
  },

  DrmPublicProfile: ({abrProfile}) => {
    let playoutFormats = {};

    Object.keys(abrProfile.playout_formats || {}).forEach(formatName => {
      if(!["fairplay", "clear"].some(name => formatName.includes(name))) {
        playoutFormats[formatName] = abrProfile.playout_formats[formatName];
      }
    });

    abrProfile.playout_formats = playoutFormats;

    return {
      ok: playoutFormats === {} ? false : true,
      result: abrProfile
    };
  },

  ReadFiles: (filePaths) => {
    const fileHandles = [];
    return filePaths.map(filePath => {
      const fullPath = absPath(filePath);
      const fileDescriptor = fs.openSync(fullPath, "r");
      fileHandles.push(fileDescriptor);
      const size = fs.fstatSync(fileDescriptor).size;
      const mimeType = mime.lookup(fullPath) || "video/mp4";

      return {
        fullPath,
        path: path.basename(fullPath),
        type: "file",
        // name: path.basename(fullPath),
        mime_type: mimeType,
        size: size,
        data: fileDescriptor
      };
    });
  },
  abrProfileDrm: defaultAbrDrmProfile,
  abrProfileClear: defaultAbrClearProfile,
  abrProfileBoth: defaultAbrBothProfile
}

module.exports = Utils;
