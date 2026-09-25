import { rebuildCatalog } from "@/lib/catalog";
import { clearCatalog, clearEnrichment, deleteAllSourceRecords, getDb, insertSourceRecords, saveEnrichment, setMeta } from "@/lib/db";
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
  };
}

function movieFile(record: SourceDraft, file: MediaFile): SourceDraft {
  return withMedia({ ...record, qualityName: file.qualityName, hdr: file.hdr, is3d: file.is3d }, [file], [record.title, file.path]);
}

export function demoRecords(): SourceDraft[] {
  const godfatherFile = video({
    path: "/movies/The Godfather (1972)/The Godfather (1972).mkv",
    qualityName: "Bluray-1080p",
    audioLanguages: ["English", "Italian"],
    subtitleLanguages: ["English"],
  });
  const godfatherPlex = movieFile(
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
      genres: ["Crime", "Drama"],
      monitored: true,
    }),
    godfatherFile,
  );
  const godfatherRadarr = movieFile(
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
    { ...godfatherFile, qualityName: "Bluray-1080p" },
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
    genres: ["Crime", "Drama"],
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

  const matrix = movieFile(
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
    video({
      container: "mp4",
      path: "/movies/The Matrix (1999)/The Matrix (1999).mp4",
      resolution: "1080p",
      hdr: "HDR10",
      audioLanguages: ["English"],
      subtitleLanguages: ["English"],
    }),
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
    parasitePlex,
    parasiteRadarr,
    parasiteBazarr,
    heat,
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
        runtimeMinutes: sample.runtimeMinutes,
        rating: null,
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
  const db = getDb();
  const write = db.transaction(() => {
    deleteAllSourceRecords(db);
    clearCatalog(db);
    clearEnrichment(db);
    setMeta(db, "demo", "0");
    setMeta(db, "last_sync_status", "idle");
    setMeta(db, "last_sync_notes", "[]");
    setMeta(db, "last_sync_at", "");
  });
  write();
}
