import { rebuildCatalog } from "@/lib/catalog";
import { clearLibrary, deleteAllSourceRecords, getDb, insertSourceRecords, saveEnrichment, setMeta } from "@/lib/db";
import { FOLDER_ONLY_AUDIO } from "@/lib/detect/sidecars";
import { enrichmentKey } from "@/lib/online";
import { sourceDraft, withMedia } from "@/lib/source";
import type { MediaFile, SourceDraft } from "@/lib/types";

function video(partial: Partial<MediaFile> & Pick<MediaFile, "path">): MediaFile {
  return {
    container: partial.container ?? "mkv",
    path: partial.path,
    qualityName: partial.qualityName ?? null,
    resolution: partial.resolution ?? "1080p",
    hdr: partial.hdr ?? "none",
    is3d: partial.is3d ?? false,
    audioLanguages: partial.audioLanguages ?? ["English"],
    subtitleLanguages: partial.subtitleLanguages ?? ["English"],
    bitrateKbps: partial.bitrateKbps ?? 8000,
  };
}

function movieFile(record: SourceDraft, file: MediaFile): SourceDraft {
  return withMedia({ ...record, qualityName: file.qualityName, hdr: file.hdr, is3d: file.is3d }, [file], [record.title, file.path]);
}

export function demoRecords(): SourceDraft[] {
  const godfatherAudio = "/movies/The Godfather (1972)/audio/The Godfather (1972).hu.ac3";
  const godfatherFile = {
    ...video({
      path: "/movies/The Godfather (1972)/The Godfather (1972).mkv",
      qualityName: "Bluray-1080p",
      audioLanguages: ["English", "Italian", "Hungarian"],
      subtitleLanguages: ["English"],
      bitrateKbps: 18000,
    }),
    audioTracks: [
      { language: "English", layout: "5.1", codec: "DTS" },
      { language: "Italian", layout: "2.0", codec: "Dolby Digital" },
      {
        language: "Hungarian",
        layout: null,
        codec: "Dolby Digital",
        file: godfatherAudio,
        fromFile: true,
        folderOnly: true,
        sources: { plex: null, file: godfatherAudio },
        conflict: FOLDER_ONLY_AUDIO,
      },
    ],
  };
  const godfatherFeaturette = video({
    path: "/movies/The Godfather (1972)/Featurettes/The Godfather - A Look Back.mkv",
    qualityName: "Bluray-480p",
    resolution: "480p",
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    bitrateKbps: 2000,
  });
  const godfatherOuttake = video({
    path: "/movies/The Godfather (1972)/Outtakes/Wedding Bloopers.mkv",
    qualityName: "Bluray-480p",
    resolution: "480p",
    audioLanguages: ["English"],
    subtitleLanguages: [],
    bitrateKbps: 1500,
  });
  const godfatherPlex = withMedia(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:godfather",
      title: "The Godfather",
      year: 1972,
      imdbId: "tt0068646",
      tmdbId: "238",
      guid: "plex://movie/godfather",
      rating: 9.2,
      contentRating: "R",
      genres: ["Crime", "Drama"],
      monitored: true,
    }),
    [godfatherFile, godfatherFeaturette, godfatherOuttake],
    ["The Godfather", godfatherFile.path, godfatherFeaturette.path, godfatherOuttake.path],
  );
  const godfatherRadarr = withMedia(
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "1",
      title: "The Godfather",
      year: 1972,
      imdbId: "tt0068646",
      tmdbId: "238",
      rating: 9.2,
      genres: ["Crime", "Drama"],
      monitored: true,
      qualityName: "Bluray-1080p",
    }),
    [godfatherFile, godfatherFeaturette, godfatherOuttake],
    ["The Godfather", godfatherFile.path, godfatherFeaturette.path, godfatherOuttake.path],
  );
  const godfatherBazarr = sourceDraft({
    connector: "bazarr",
    kind: "movie",
    externalKey: "radarr:1",
    title: "The Godfather",
    year: 1972,
    imdbId: "tt0068646",
    tmdbId: "238",
    audioLanguages: ["English", "Italian"],
    subtitleLanguages: ["English"],
    monitored: true,
  });

  const partTwo = sourceDraft({
    connector: "radarr",
    kind: "movie",
    externalKey: "2",
    title: "The Godfather Part II",
    year: 1974,
    imdbId: "tt0071562",
    tmdbId: "240",
    rating: 9.0,
    contentRating: "PG",
    genres: [],
    monitored: true,
    wanted: true,
    hasFile: false,
  });

  const avatarFile: MediaFile = {
    container: "m2ts",
    path: "/movies/Avatar (2009)/BDMV/STREAM/00000.m2ts",
    qualityName: "Bluray-1080p",
    resolution: "1080p",
    hdr: "none",
    is3d: false,
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
  };
  const avatarPlex = movieFile(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:avatar",
      title: "Avatar",
      year: 2009,
      imdbId: "tt0499549",
      tmdbId: "19995",
      guid: "plex://movie/avatar",
      rating: 7.6,
      genres: ["Science Fiction", "Adventure"],
      monitored: true,
    }),
    avatarFile,
  );
  const avatarRadarr = movieFile(
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "3",
      title: "Avatar",
      year: 2009,
      imdbId: "tt0499549",
      tmdbId: "19995",
      rating: 7.6,
      genres: ["Science Fiction", "Adventure"],
      monitored: true,
      qualityName: "Bluray-1080p",
    }),
    avatarFile,
  );

  const gravityFile = video({
    path: "/movies/Gravity (2013)/Gravity (2013) HSBS.mkv",
    qualityName: "Bluray-1080p",
    is3d: true,
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
  });
  const gravity = movieFile(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:gravity",
      title: "Gravity",
      year: 2013,
      imdbId: "tt1454468",
      tmdbId: "49047",
      rating: 7.2,
      genres: ["Science Fiction", "Thriller"],
      monitored: true,
    }),
    gravityFile,
  );
  const gravityRadarr = movieFile(
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "4",
      title: "Gravity",
      year: 2013,
      imdbId: "tt1454468",
      tmdbId: "49047",
      rating: 7.2,
      genres: ["Science Fiction", "Thriller"],
      monitored: true,
      qualityName: "Bluray-1080p",
    }),
    gravityFile,
  );

  const duneFile = video({
    container: "mkv",
    path: "/movies/Dune (2021)/Dune (2021).mkv",
    qualityName: "Bluray-2160p Remux",
    resolution: "2160p",
    hdr: "Dolby Vision",
    audioLanguages: ["English"],
    subtitleLanguages: ["English", "Hungarian"],
  });
  const dunePlex = movieFile(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:dune",
      title: "Dune",
      year: 2021,
      imdbId: "tt1160419",
      tmdbId: "438631",
      rating: 8.0,
      genres: ["Science Fiction", "Adventure"],
      monitored: true,
    }),
    duneFile,
  );
  const duneRadarr = movieFile(
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "5",
      title: "Dune",
      year: 2021,
      imdbId: "tt1160419",
      tmdbId: "438631",
      rating: 8.0,
      genres: ["Science Fiction", "Adventure"],
      monitored: true,
      qualityName: "Bluray-2160p Remux",
    }),
    duneFile,
  );
  const duneBazarr = sourceDraft({
    connector: "bazarr",
    kind: "movie",
    externalKey: "radarr:5",
    title: "Dune",
    year: 2021,
    imdbId: "tt1160419",
    tmdbId: "438631",
    subtitleLanguages: ["English", "Hungarian"],
    audioLanguages: ["English"],
    monitored: true,
  });

  const matrixHd = video({
    container: "mp4",
    path: "/movies/The Matrix (1999)/The Matrix (1999).mp4",
    resolution: "1080p",
    hdr: "HDR10",
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
  });
  const matrixSd = video({
    container: "mkv",
    path: "/movies/The Matrix (1999)/The Matrix (1999)-720p.mkv",
    resolution: "720p",
    hdr: "none",
    qualityName: "HDTV-720p",
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    bitrateKbps: 4000,
  });
  const matrix = withMedia(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:matrix",
      title: "The Matrix",
      year: 1999,
      imdbId: "tt0133093",
      tmdbId: "603",
      rating: 8.7,
      genres: ["Science Fiction", "Action"],
      monitored: true,
    }),
    [matrixHd, matrixSd],
    ["The Matrix", matrixHd.path, matrixSd.path],
  );

  const lawrenceCd1 = video({
    container: "avi",
    path: "/movies/Lawrence of Arabia (1962)/Lawrence of Arabia (1962) - CD1.avi",
    resolution: "480p",
    qualityName: "DVD",
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    bitrateKbps: 1500,
  });
  const lawrenceCd2 = video({
    container: "avi",
    path: "/movies/Lawrence of Arabia (1962)/Lawrence of Arabia (1962) - CD2.avi",
    resolution: "480p",
    qualityName: "DVD",
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    bitrateKbps: 1500,
  });
  const lawrence = withMedia(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:lawrence",
      title: "Lawrence of Arabia",
      year: 1962,
      imdbId: "tt0056172",
      tmdbId: "947",
      rating: 8.3,
      genres: ["Adventure", "History"],
      monitored: true,
    }),
    [lawrenceCd1, lawrenceCd2],
    ["Lawrence of Arabia", lawrenceCd1.path, lawrenceCd2.path],
  );

  const parasiteFile = video({
    path: "/movies/Parasite (2019)/Parasite (2019).mkv",
    qualityName: "Bluray-1080p",
    audioLanguages: ["Korean"],
    subtitleLanguages: ["English"],
  });
  const parasiteRadarr = movieFile(
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "6",
      title: "Parasite",
      year: 2019,
      imdbId: "tt6751668",
      tmdbId: "496243",
      rating: 8.5,
      genres: ["Thriller", "Drama"],
      monitored: true,
      qualityName: "Bluray-1080p",
    }),
    parasiteFile,
  );
  const parasitePlex = movieFile(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:parasite",
      title: "Parasite",
      year: 2019,
      imdbId: "tt6751668",
      tmdbId: "496243",
      rating: 8.5,
      genres: ["Thriller", "Drama"],
      monitored: true,
    }),
    parasiteFile,
  );
  const parasiteBazarr = sourceDraft({
    connector: "bazarr",
    kind: "movie",
    externalKey: "radarr:6",
    title: "Parasite",
    year: 2019,
    imdbId: "tt6751668",
    tmdbId: "496243",
    audioLanguages: ["Korean"],
    subtitleLanguages: ["English"],
    subtitleWanted: ["Spanish"],
    monitored: true,
  });

  const heat = movieFile(
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "7",
      title: "Heat",
      year: 1995,
      imdbId: "tt0113277",
      tmdbId: "949",
      genres: ["Crime", "Drama"],
      monitored: true,
      qualityName: "Bluray-1080p",
      rating: null,
    }),
    video({
      path: "/movies/Heat (1995)/Heat (1995).mkv",
      qualityName: "Bluray-1080p",
      audioLanguages: ["English"],
      subtitleLanguages: [],
    }),
  );

  const kingdomTheatrical = video({
    path: "/movies/Kingdom of Heaven (2005)/Kingdom of Heaven (2005)-theatrical.mkv",
    qualityName: "Bluray-1080p",
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    bitrateKbps: 12000,
  });
  const kingdomDirectors = video({
    path: "/movies/Kingdom of Heaven (2005)/Kingdom of Heaven (2005)-directors.mkv",
    qualityName: "Bluray-1080p",
    resolution: "1080p",
    audioLanguages: ["English"],
    subtitleLanguages: ["English"],
    bitrateKbps: 14000,
  });
  const kingdomPlex = withMedia(
    sourceDraft({
      connector: "plex",
      kind: "movie",
      externalKey: "item:kingdom",
      title: "Kingdom of Heaven",
      year: 2005,
      imdbId: "tt0399146",
      tmdbId: "1495",
      rating: 7.3,
      genres: ["Action", "Adventure", "Drama"],
      monitored: true,
    }),
    [kingdomTheatrical, kingdomDirectors],
    ["Kingdom of Heaven", kingdomTheatrical.path, kingdomDirectors.path],
  );
  const kingdomRadarr = withMedia(
    sourceDraft({
      connector: "radarr",
      kind: "movie",
      externalKey: "8",
      title: "Kingdom of Heaven",
      year: 2005,
      imdbId: "tt0399146",
      tmdbId: "1495",
      rating: 7.3,
      genres: ["Action", "Adventure", "Drama"],
      monitored: true,
      qualityName: "Bluray-1080p",
    }),
    [kingdomTheatrical, kingdomDirectors],
    ["Kingdom of Heaven", kingdomTheatrical.path, kingdomDirectors.path],
  );

  const wire: SourceDraft = sourceDraft({
    connector: "sonarr",
    kind: "series",
    externalKey: "10",
    title: "The Wire",
    year: 2002,
    imdbId: "tt0306414",
    tmdbId: "1438",
    tvdbId: "79126",
    parentKey: "sonarr-series:10",
    rating: 9.3,
    genres: ["Crime", "Drama"],
    monitored: true,
    hasFile: true,
  });
  const wirePlex = sourceDraft({
    connector: "plex",
    kind: "series",
    externalKey: "item:wire",
    title: "The Wire",
    year: 2002,
    imdbId: "tt0306414",
    tvdbId: "79126",
    guid: "plex://show/wire",
    parentKey: "plex:plex://show/wire",
    rating: 9.3,
    genres: ["Crime", "Drama"],
    monitored: true,
  });

  const wireEpisodes: SourceDraft[] = [
    movieFile(
      sourceDraft({
        connector: "plex",
        kind: "episode",
        externalKey: "episode:wire-1",
        title: "The Target",
        seriesTitle: "The Wire",
        year: 2002,
        season: 1,
        episode: 1,
        imdbId: "tt0306414",
        tvdbId: "79126",
        parentKey: "plex:plex://show/wire",
        monitored: true,
      }),
      video({
        path: "/tv/The Wire/Season 1/The Wire S01E01.mkv",
        qualityName: null,
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
      }),
    ),
    movieFile(
      sourceDraft({
        connector: "sonarr",
        kind: "episode",
        externalKey: "101",
        title: "The Target",
        seriesTitle: "The Wire",
        year: 2002,
        season: 1,
        episode: 1,
        imdbId: "tt0306414",
        tvdbId: "79126",
        parentKey: "sonarr-series:10",
        monitored: true,
        airDate: "2002-06-02T00:00:00Z",
        qualityName: "HDTV-1080p",
      }),
      video({
        path: "/tv/The Wire/Season 1/The Wire S01E01.mkv",
        qualityName: "HDTV-1080p",
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
      }),
    ),
    movieFile(
      sourceDraft({
        connector: "sonarr",
        kind: "episode",
        externalKey: "102",
        title: "The Detail",
        seriesTitle: "The Wire",
        year: 2002,
        season: 1,
        episode: 2,
        imdbId: "tt0306414",
        tvdbId: "79126",
        parentKey: "sonarr-series:10",
        monitored: true,
        airDate: "2002-06-09T00:00:00Z",
        qualityName: "HDTV-1080p",
      }),
      video({
        path: "/tv/The Wire/Season 1/The Wire S01E02.mkv",
        qualityName: "HDTV-1080p",
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
      }),
    ),
    sourceDraft({
      connector: "sonarr",
      kind: "episode",
      externalKey: "103",
      title: "The Buys",
      seriesTitle: "The Wire",
      year: 2002,
      season: 1,
      episode: 3,
      imdbId: "tt0306414",
      tvdbId: "79126",
      parentKey: "sonarr-series:10",
      monitored: true,
      wanted: true,
      hasFile: false,
      airDate: "2002-06-16T00:00:00Z",
    }),
    sourceDraft({
      connector: "sonarr",
      kind: "episode",
      externalKey: "104",
      title: "Old Cases",
      seriesTitle: "The Wire",
      year: 2002,
      season: 1,
      episode: 4,
      imdbId: "tt0306414",
      tvdbId: "79126",
      parentKey: "sonarr-series:10",
      monitored: true,
      wanted: false,
      hasFile: false,
      airDate: "2099-01-01T00:00:00Z",
    }),
    sourceDraft({
      connector: "bazarr",
      kind: "episode",
      externalKey: "sonarr-episode:101",
      title: "The Target",
      seriesTitle: "The Wire",
      year: 2002,
      season: 1,
      episode: 1,
      tvdbId: "79126",
      parentKey: "sonarr-series:10",
      subtitleLanguages: ["English"],
      audioLanguages: ["English"],
    }),
    sourceDraft({
      connector: "bazarr",
      kind: "episode",
      externalKey: "sonarr-episode:102",
      title: "The Detail",
      seriesTitle: "The Wire",
      year: 2002,
      season: 1,
      episode: 2,
      tvdbId: "79126",
      parentKey: "sonarr-series:10",
      subtitleLanguages: ["English"],
      subtitleWanted: ["Hungarian"],
      audioLanguages: ["English"],
    }),
  ];

  const chernobyl = sourceDraft({
    connector: "sonarr",
    kind: "series",
    externalKey: "20",
    title: "Chernobyl",
    year: 2019,
    imdbId: "tt7366338",
    tvdbId: "360893",
    parentKey: "sonarr-series:20",
    rating: 9.4,
    genres: ["Drama", "History"],
    monitored: true,
    hasFile: true,
  });
  const chernobylEpisodes: SourceDraft[] = [1, 2].map((episode) =>
    movieFile(
      sourceDraft({
        connector: "sonarr",
        kind: "episode",
        externalKey: `20${episode}`,
        title: episode === 1 ? "1:23:45" : "Please Remain Calm",
        seriesTitle: "Chernobyl",
        year: 2019,
        season: 1,
        episode,
        imdbId: "tt7366338",
        tvdbId: "360893",
        parentKey: "sonarr-series:20",
        monitored: true,
        airDate: "2019-05-06T00:00:00Z",
        qualityName: "Bluray-2160p",
      }),
      video({
        path: `/tv/Chernobyl/Season 1/Chernobyl S01E0${episode}.mkv`,
        qualityName: "Bluray-2160p",
        resolution: "2160p",
        hdr: "HDR10",
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
      }),
    ),
  );

  const bear = sourceDraft({
    connector: "sonarr",
    kind: "series",
    externalKey: "30",
    title: "The Bear",
    year: 2022,
    imdbId: "tt14452776",
    tvdbId: "403293",
    parentKey: "sonarr-series:30",
    rating: 8.6,
    genres: ["Comedy", "Drama"],
    monitored: true,
  });
  const bearEpisodes: SourceDraft[] = [
    movieFile(
      sourceDraft({
        connector: "sonarr",
        kind: "episode",
        externalKey: "301",
        title: "System",
        seriesTitle: "The Bear",
        year: 2022,
        season: 1,
        episode: 1,
        imdbId: "tt14452776",
        tvdbId: "403293",
        parentKey: "sonarr-series:30",
        monitored: true,
        airDate: "2022-06-23T00:00:00Z",
        qualityName: "WEBDL-1080p",
      }),
      video({
        path: "/tv/The Bear/Season 1/The Bear S01E01.mkv",
        qualityName: "WEBDL-1080p",
        audioLanguages: ["English"],
        subtitleLanguages: ["English"],
      }),
    ),
    sourceDraft({
      connector: "sonarr",
      kind: "episode",
      externalKey: "302",
      title: "Hands",
      seriesTitle: "The Bear",
      year: 2022,
      season: 1,
      episode: 2,
      imdbId: "tt14452776",
      tvdbId: "403293",
      parentKey: "sonarr-series:30",
      monitored: true,
      wanted: true,
      hasFile: false,
      airDate: "2022-06-23T00:00:00Z",
    }),
  ];

  return [
    godfatherPlex,
    godfatherRadarr,
    godfatherBazarr,
    partTwo,
    avatarPlex,
    avatarRadarr,
    gravity,
    gravityRadarr,
    dunePlex,
    duneRadarr,
    duneBazarr,
    matrix,
    lawrence,
    parasitePlex,
    parasiteRadarr,
    parasiteBazarr,
    heat,
    kingdomPlex,
    kingdomRadarr,
    wire,
    wirePlex,
    ...wireEpisodes,
    chernobyl,
    ...chernobylEpisodes,
    bear,
    ...bearEpisodes,
  ];
}

export function loadDemoLibrary() {
  const db = getDb();
  const now = new Date().toISOString();
  const write = db.transaction(() => {
    deleteAllSourceRecords(db);
    insertSourceRecords(db, demoRecords());
    rebuildCatalog(db);
    setMeta(db, "demo", "1");
    setMeta(db, "last_sync_at", now);
    setMeta(db, "last_sync_status", "success");
    setMeta(
      db,
      "last_sync_notes",
      JSON.stringify([
        { id: "plex", ok: true, message: "Demo library. No server was contacted." },
        { id: "radarr", ok: true, message: "Demo library. No server was contacted." },
        { id: "sonarr", ok: true, message: "Demo library. No server was contacted." },
        { id: "bazarr", ok: true, message: "Demo library. No server was contacted." },
      ]),
    );
    seedDemoOnline(db, now);
  });
  write();
}

function seedDemoOnline(db: ReturnType<typeof getDb>, fetchedAt: string) {
  const samples = [
    {
      imdbId: "tt0068646",
      kind: "movie" as const,
      title: "The Godfather",
      year: 1972,
      overview: "A crime saga about the Corleone family, included with the demo so the detail panel has something to show before a live lookup.",
      posterUrl: "https://image.tmdb.org/t/p/w342/3bhkrj58Vtu7enYsRolD1fZdja1.jpg",
      runtimeMinutes: 175,
    },
    {
      imdbId: "tt0306414",
      kind: "series" as const,
      title: "The Wire",
      year: 2002,
      overview: "A Baltimore crime series in the demo library, with a short note filled locally rather than from a server.",
      posterUrl: "https://image.tmdb.org/t/p/w342/4lbclFySvugI51fwsyxBTOm4DqK.jpg",
      runtimeMinutes: 60,
    },
  ];
  for (const sample of samples) {
    saveEnrichment(
      enrichmentKey({
        kind: sample.kind,
        title: sample.title,
        year: sample.year,
        imdbId: sample.imdbId,
        tmdbId: null,
        tvdbId: null,
      }),
      sample.kind,
      {
        status: "found",
        sources: ["tmdb"],
        overview: sample.overview,
        posterUrl: sample.posterUrl,
        originalTitle: sample.title,
        localTitles: {},
        runtimeMinutes: sample.runtimeMinutes,
        rating: null,
        contentRating: null,
        genres: [],
        imdbId: sample.imdbId,
        tmdbId: null,
        tvdbId: null,
        message: "Demo note. No online source was contacted.",
        fetchedAt,
      },
      db,
    );
  }
}

export function clearDemoLibrary() {
  clearLibrary();
}
