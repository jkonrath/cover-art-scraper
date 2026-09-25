# bandcamp-covers

Finds full-resolution album cover art on Bandcamp for a list of albums in a CSV file. It can also download the covers and check whether each one is at least 1600×1600 pixels.

Bandcamp is a good source for indie releases because artists upload their original art files. Albums the script can't find, or can't find in a large enough size, are listed at the end so you can look them up by hand, for example on [covers.musichoarders.xyz](https://covers.musichoarders.xyz).

## Requirements

- Node.js 18 or later
- No other dependencies. The script is a single file, `bandcamp-covers.js`.

## Quick start

1. Make a CSV file with a header row and one album per line:

   ```csv
   artist,album
   Car Seat Headrest,Teens of Denial
   Jeff Rosenstock,WORRY.
   Big Thief,Capacity
   ```

2. Run the script to find the albums:

   ```bash
   node bandcamp-covers.js albums.csv
   ```

3. Or find the albums and download their covers:

   ```bash
   node bandcamp-covers.js albums.csv --download
   ```

Each run writes a new results file, such as `results-20260925-143012.csv`. With `--download`, the covers go into a folder with the same timestamp, such as `covers-20260925-143012/`. Runs never overwrite each other.

## Options

| Option | What it does |
|---|---|
| `--download` | Download the cover for each MATCH row and check its size |
| `--include-check` | With `--download`, also download covers for CHECK rows |
| `--skip-bad-rows` | Search the good rows even if some rows have problems (see [Input checks](#input-checks)) |
| `--delay <ms>` | Wait this many milliseconds between searches. The default is `1000`. |
| `--out <file>` | Results file name. The default is `results-yyyymmdd-hhmmss.csv`. |
| `--covers <dir>` | Download folder. The default is `covers-yyyymmdd-hhmmss`. |
| `--help` | Show usage |

Timestamps use your computer's local time and mark when the run started.

## Input file

- **Format:** a plain-text CSV saved as **UTF-8**. In Excel, choose **File > Save As > CSV UTF-8 (Comma delimited)**. Excel's plain "CSV" format garbles accented letters, so the script rejects it.
- **Header:** the first line must name the columns and include `artist` and `album`. The script ignores capitalization and any other columns, and the columns can be in any order.
- **Commas in names:** put quotes around any name that contains a comma:

  ```csv
  nuclear winter,"hail, satan"
  ```

- **Quote marks in names:** inside a quoted name, write each quote mark twice. `"The ""Heroes"" Album"` is read as `The "Heroes" Album`.
- **Blank lines:** these are skipped.

### Converting an "Artist - Album" text list

If your list is a text file with one `Artist - Album` per line, convert it before running the script:

1. Add `artist,album` as the first line.
2. Change the first ` - ` on each line to a comma. Keep any later ` - `, since it's part of the title, as in `Azure,King of Stars - Bearer of Dark`.
3. Put quotes around any artist or album that contains a comma.

## Output

### Progress

The script prints one line per album as it runs:

```
[1/3] MATCH     Big Thief - Two Hands -> Big Thief - Two Hands 4000x4000
[2/3] TOO SMALL Big Thief - Capacity -> Big Thief - Capacity 1400x1400
[3/3] NO MATCH  Zzqx Band - Qqqz Album (no album results)
```

At the end it prints:

- how many albums got each status
- a **Needs manual lookup** list of every album that isn't a MATCH at 1600px or larger

Without `--download` the cover sizes are unknown, so this list only includes the albums that aren't a MATCH.

### Results file

The results file has these columns:

| Column | Contents |
|---|---|
| `artist`, `album` | Your input |
| `status` | See the statuses below |
| `matched_artist`, `matched_album` | What Bandcamp found |
| `page_url` | The album's Bandcamp page |
| `cover_url` | The full-resolution cover image |
| `width`, `height` | Cover size in pixels (only with `--download`) |

### Statuses

| Status | Meaning |
|---|---|
| `MATCH` | The artist and album both match closely |
| `CHECK` | A partial match. Look at it yourself, because it may be a different album or artist. |
| `NO MATCH` | Nothing on Bandcamp matched well enough |
| `TOO SMALL` | Matched and downloaded, but the shorter side is under 1600px |
| `ERROR` | The search failed (an HTTP error or a bot challenge) |
| `INVALID` | A bad input row that was skipped with `--skip-bad-rows`. The whole line is in the `artist` column. |

### Downloaded covers

With `--download`, each cover is saved as `Artist - Album.jpg`. Characters that aren't allowed in file names are replaced with `_`.

The size check reads the real pixel dimensions from the downloaded file, not from what Bandcamp reports.

Many Bandcamp originals are smaller than 1600px (often 1400 or 1500), so expect a fair number of TOO SMALL results.

## How it works

### Searching

For each album, the script sends one search to Bandcamp: the same search the Bandcamp site's search box uses, limited to albums. It sends one search at a time, with a pause between them.

### Matching

Names are compared after these changes:

- accents removed (é becomes e)
- converted to lowercase
- `&` changed to `and`
- everything except letters and digits removed

Each search result is scored twice, once on the album title and once on the artist:

- **+2** if the names are identical after cleanup
- **+1** if one contains the other

The best-scoring result is used:

- **4:** MATCH
- **2 or 3:** CHECK
- **less than 2:** NO MATCH

### Cover URLs

Bandcamp stores the original uploaded image at:

```
https://f4.bcbits.com/img/a<art_id>_0.jpg
```

`<art_id>` is padded with zeros to 10 digits. The `a` in front is required. The thumbnail URL in Bandcamp's search results leaves it out, so changing only the thumbnail's size number returns a "not found" error.

## Input checks

Before any search runs, the script checks the whole input file. It lists every problem with its line number, shows the line itself, and says how to fix it:

```
Problem, line 3: has 3 columns, but the header has 2. A name probably contains a comma without quotes around it. Put quotes around any name with a comma in it, e.g. nuclear winter,"hail, satan"
    nuclear winter,hail, satan
Warning, line 8: "BIG THIEF - capacity" is a repeat of line 2. It will be skipped.

Error: Found 1 problem row in "albums.csv" (listed above). Nothing was searched.
```

### Problems that stop the run

**File problems:**

- The file doesn't exist, is a folder, or is empty.
- It's an Excel `.xlsx` file, UTF-16 text, or binary data.
- It isn't UTF-8. This usually means it was saved as Excel's plain "CSV" instead of "CSV UTF-8". The message shows the first bad line.
- A quote mark is opened but never closed. Everything after it would be read as one name.

**Header problems:**

- There's no header line, or the first line is an album.
- Tabs or semicolons separate the columns instead of commas.
- It has `title` instead of `album`.
- A column name appears twice.
- There are no albums under it.

**Row problems.** With `--skip-bad-rows`, these rows are skipped and listed as INVALID in the results instead of stopping the run.

- **Wrong number of columns:** every row must have exactly as many columns as the header. This is how a name with an unquoted comma gets caught.
  - Files saved from Excel always meet this rule.
  - A hand-typed file that leaves off empty columns at the end of a row won't.
- **Blank name:** the artist or album is blank.
- **Unconverted line:** the line is still in `Artist - Album` form.
- **Text after a closing quote:** for example, `"Big Thief" Band`.

**Command-line problems:**

- An option is missing its value.
- `--delay` isn't a number.
- The option isn't recognized.
- Two input files were given. This usually means a file name has spaces and needs quotes around it.
- The folder for the results file doesn't exist, or can't be written to. This is checked before searching, so a long run can't fail at the very end.

### Warnings (the run continues)

- **Duplicate album:** only the first copy is searched. Differences in capitalization, accents and punctuation don't count, so `AC/DC` and `AC_DC` are the same.
- **Quote mark in the middle of an unquoted name:** it's kept as part of the name.
- **Line breaks, tabs, or invisible characters in a name:** these are cleaned up. Invisible characters often come from text copied off web pages.
- **Name with `�`:** the text was already garbled by an earlier conversion. Retype it.
- **Name with no letters or digits** (such as `???`): this can't be matched automatically.
- **Name over 150 characters:** usually two rows merged by a stray quote mark.

## Limitations

- **Unofficial search.** Bandcamp has no public API. The script uses the search that runs behind Bandcamp's own search box, which could change or stop working without notice.
- **Bot checks.** If Bandcamp responds with a bot check instead of search results, the album is marked ERROR and the script moves on. If you see many ERRORs, wait a while and try a longer `--delay`.
- **Bandcamp only.** Albums that aren't on Bandcamp come back as NO MATCH. Some major-label and older releases aren't there.
- **Results are written at the end.** If you stop a run partway through (Ctrl-C), nothing from that run is saved. Split very long lists into smaller files.
- **Opening results in Excel.** If an artist or album name starts with `=`, `+`, `-` or `@`, Excel may treat it as a formula when you open the results file.
