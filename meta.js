// "Artist - Song" uploaded by someone else → { artist: "Artist", title: "Song" }; "(prod X)" stays in the title.
globalThis.scdlTrackMeta = (rawTitle, fallbackArtist) => {
  const title = rawTitle.trim();
  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!dash) return { artist: fallbackArtist, title };
  const feat = dash[1].trim().match(/^(?:w\/|with|ft\.?|feat\.?)\s*(.+)$/i); // "w/ lil peep - x" by uploader
  return { artist: feat ? `${fallbackArtist}, ${feat[1]}` : dash[1].trim(), title: dash[2].trim() };
};
