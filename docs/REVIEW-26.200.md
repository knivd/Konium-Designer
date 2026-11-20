# The review before the source went public (26.200)

26.200 is the first build whose source is public. Before it, the whole code was gone through for
what a stranger, and a hostile one, would find: holes in the services behind konium.app, ways a
crafted file could attack whoever opens it, ways a design could be lost or damaged, private matter
that must not be published, and public statements the code does not bear out.

How it was done: ten reviewers were started, one area each; they were stopped early (their cost),
and six had written part of their findings by then. Every finding below was then read against the
code by the one reviewer who carried on, fixed, and given a test where a test can show it. What
the six had not reached, and the four areas whose reviewers wrote nothing, were then gone through
by kind of fault rather than file by file, most dangerous first: section 6 says what was swept
for across the whole code, and what was not read line by line. A finding counts when the code
path was read and the way it goes wrong is concrete; "could be tidier" does not count.

Status words: **fixed** (in this build, with the test named), **open** (confirmed, not yet
fixed), **to check** (reported, not yet read against the code), **decision** (the author's to make).

## 1. The services (cloudflare/)

| # | Severity | Where | What | Status |
|---|---|---|---|---|
| S1 | critical | vcs: the Git relay | A server's answer came back from konium.app with the server's own headers, its content type among them: a link could make a browser run a stranger's page as konium.app's | **fixed**: only Git's content types pass, nothing else of the server's headers; marked a download, not to be sniffed or run; a browser asking for it as a page, frame, script or worker is refused (tests/vcsWorker140.test.ts) |
| S2 | critical | vcs: the team store | Any made-up token started a team with a full allowance, with no count of teams; a team's allowance was read, then written, so pushes sent together each saw room | **fixed**: a ledger (a Durable Object) takes the room with the check; new teams a day for a user and for the service; megabytes a day for a user; a ceiling on the whole store; a size not said is not read (same tests) |
| S3 | critical | report: a large report's parts | A part was passed to GitHub as the sender wrote it, so the sender chose the commit's message, author, branch and whether it replaced a file; outside the rate limit | **fixed**: a part is passed on only when it is the app's own request to the letter (the opening for that report and part, the closing, no quotation mark or backslash between); a part there already is never replaced; parts have a rate limit of their own (tests/report196.test.ts) |
| S4 | important | ai: the day's budget | Looked at before a job and added to after it: jobs started together all pass | **fixed**: a job's likely cost is set aside before the model is asked, in the one step that checks the budget, and settled to its real cost after; a failed job gives it back (tests/services200.test.ts) |
| S5 | important | ai: the shared cache of accepted readings | Anyone could write the reading kept for a datasheet; the cache had no end | **fixed**: a reading is kept only with the pass the service gave with that very answer (signed, for that job, datasheet, user and answer, a day long); the cache holds 20,000 answers, the longest untouched going first (tests/ai75.test.ts, tests/services200.test.ts) |
| S6 | important | library: a part's commit | The part number, maker and package name went into the commit message as sent (line breaks, mentions, issue numbers) | **fixed**: every text of a record is put on one line; in the commit's message `@` and `#` are replaced by their wide forms, so nothing there names anyone or closes anything (tests/services200.test.ts) |
| S7 | important | report: the issue's text | A report's text could end its own code fence and continue as live Markdown | **fixed**: the fence is made longer than any run of back-ticks in the text; file names on one line with Markdown's marks escaped (tests/report196.test.ts) |
| S8 | important | ai: fetching a datasheet | The answer read without a limit; only the first address tested, not where it redirects to | **fixed**: named hosts on the web's own ports only (no numeric address, no private network's name, not konium.app); redirects followed by hand, each held to the same rule, five at most; read to 30 MB and no further, within 20 seconds; handed on as a file, never as a page (tests/services200.test.ts) |
| S9 | important | all five | Size limits tested the Content-Length header, which a request may leave out | **fixed**: every body is read through one reader that stops at its limit whatever the header says (cloudflare/body.ts; tests/services200.test.ts); the team store refuses a write that does not say its size |
| S10 | important | library: sign-in mails | No count for the whole service; three requests an hour lock an address out of signing in | **fixed**: 60 links an hour and 400 a day for the whole service; whoever asks from where an address last signed in has a count of their own, so strangers cannot use theirs up (tests/services200.test.ts) |

Read since: every place the program can make a request (the eleven modules that call out, the
one outside script, the worker's registration). Each asks the network switch first, and each is
a row of the list the program shows (16 rows).

## 2. What a file, a script or a model's answer can inject

| # | Severity | Where | What | Status |
|---|---|---|---|---|
| I1 | critical | src/app/MultiBoardViews.tsx | A multi-board document's style colours went into the drawing's markup unchecked: opening the file could run a script | **fixed**: colours, widths and dashes reach the markup as numbers only (`mbsColour`, `mbsLine`); the file's lists are made lists of objects before anything walks them (tests/review200.test.ts) |
| I2 | critical | src/scripting/sandbox.ts, src/app/scripts.ts | What a sandboxed script reports back was shown unchecked: a crafted line could become an element of the page; a change's fields were trusted as the script's own runtime had checked them, and a script can post a message itself | **fixed**: a message from the frame is rebuilt from checked values before anything uses it (src/scripting/outcome.ts): texts are strings, numbers finite, lists have an end, and a change that is not one a script can ask for fails the run (tests/review200.test.ts) |
| I3 | important | src/app/diagram/richtext.ts | The diagram label cleaner's style filter could be passed with character references that lack their semicolon | **fixed**: every attribute kept is written as text (its ampersands escaped), and a style's value may be made only of what a colour, a size or a font's name is made of (tests/review200.test.ts) |
| I4 | minor | src/render/svgExport.ts | A font name from a file went into a style attribute of the print picture | **fixed**: only what a name is made of is kept, in quotes |

Read since: every place the source writes markup or runs text (17: the two drawings shown as
markup, the print window, the rich-text editors and their cleaners, the script frame), and every
message listener (the script frame's is the only one that hears anything but Konium Designer's
own workers). The requirement document's reader checks each state, priority and kind against its
list before the report writes it into a class. The What's New log is taken in as text and
pictures only, and a picture is now taken only from the site itself, so the row of the
connections' list that names konium.app holds whatever the log says. A pasted picture is kept as
its bytes under a type the browser can draw, never as an address.

## 3. Losing or damaging a design

| # | Severity | Where | What | Status |
|---|---|---|---|---|
| D1 | critical | src/model/pcbEdit.ts (removeOwners) | Deleting or exploding a pour renumbered the plane-edge tracks that carry the board's own mark (0xFFFE) | **fixed**: an index past the owners' list is no owner's and its record is left exactly as it is (tests/review200.test.ts) |
| D2 | important | src/model/pcbEdit.ts | Vias that belong to a component are not in the ownership table: not moved, removed or renumbered with it | **confirmed** on boards saved by the desktop software (four of thirty had such vias, up to 166 on one) and **fixed**: a via reads its component (offset 7, as every primitive), goes where its part goes and when it goes, and a placed footprint's vias are the part's (tests/review200.test.ts) |
| D3 | critical | src/app/backup.ts | Recovery copies of a crashed session were deleted when a document of the same name was closed or saved in another | **fixed**: a document saved or closed drops this session's copies of it and no others (tests/review200.test.ts) |
| D4 | important | src/app/backup.ts | Opening a recovered copy could bring another open document forward and then lose the copy | **fixed**: the copy opens beside a document of its name under a name of its own, and counts as opened only when a document was made from its very bytes; otherwise it stays offered, and that is said |
| D5 | important | src/app/actions.ts | A Save As that was cancelled left its chosen format on the document for the next Save | **fixed**: the type chosen becomes the document's only when the file was written |
| D6 | important | src/app/actions.ts | A second free file with the name of an open one was not opened, without a word | **fixed**: said, with the open one shown (opening two documents of one name is not possible yet: documents are known by name in too many places) |
| D7 | important | src/app/backup.ts | A copy the browser refused to keep (no room) was never said | **fixed**: said once a session, for Auto Save and for Local History kept in the browser |
| D8 | important | src/formats/step/write.ts | STEP export leaves out a model it cannot read without saying so | **confirmed** and **fixed**: the parts left out are named when the file is written, from every place that writes one (tests/outputs40.test.ts) |

Not read line by line: the rest of src/model, the editors, the Altium readers and writers, the
other formats, the manufacturing outputs and the analyses (section 6 says what they were swept
for). They are what the tests and the browser run exercise most: about 1,900 tests and 820
browser checks, among them round trips through every format and comparisons with files saved by
the programs themselves.

## 4. What must not, or should not, be published as it stands

| # | Severity | Where | What | Status |
|---|---|---|---|---|
| P1 | critical | the private repository's history | Addresses, session links and working notes in 198 commits | **settled**: the public repository starts from one clean commit |
| P2 | critical | tests/sheetview.test.ts, tests/libraries.test.ts, tests/outjob.test.ts, src/platform/recent.ts | Names of real projects, a company and a drive path, used as test data | **fixed**: invented names; the tracked files swept for addresses, paths, keys and session links (none) |
| P3 | important | src/app/menus/ad17.gen.ts, tests/tools/rcs/ | The menus, captions, shortcuts and button descriptions were generated from an installed Altium Designer 17's resource files; About and the README say nothing of Altium's is used | **decision**, and the wording corrected whatever is decided |
| P4 | important | the built program | The software of others built in was shipped without its notices | **fixed**: the build writes them into the page (Help › About › Third-Party Software) |
| P5 | important | About, Contact, the guides | Still say the source can be audited on request | **fixed**: About has Source Code, Licence and Third-Party Software; the contact topic is now a security problem reported privately (SECURITY.md); the guides and the website say the source is public |
| P6 | important | docs/RELEASES.md, UNRELEASED.md | Written as a private working log ("the user said", reporters, the forum, plans for charging) | **fixed**: the quotes of private instructions reworded, the commercial notes and the private repositories' names moved out of the public tree |
| P7 | minor | several | Three different addresses for the repository; stale "provisional" notes; hidden address switches not written down; an internal remark about What's New; tools that need programs not declared | **fixed**: one address; the notes say what holds now; the three address switches are in the README; the README says what each tool needs |
| P8 | minor | src/formats/gerber/strokeFont.ts | The Hershey stroke font's own notice is not among the third-party notices | **fixed**: its acknowledgements and the MIT notice of the package the glyphs were taken from are in the list the build writes |

## 5. Public statements

| # | Severity | Where | What | Status |
|---|---|---|---|---|
| C1 | important | About, the website, the guide, llms.txt | "The browser itself refuses every connection" with network activity off: the policy leaves scripts, styles, workers and the manifest out, and the browser's own check of the offline files cannot be stopped from the page | **fixed**: the policy now names every kind of thing a page can load, with `default-src 'none'` for any other; the manifest and the worker are not asked for with network activity off; the one thing no page can stop (the browser's own daily look for newer offline files, at konium.app copies only) is said in the list, the guide and the website (tests/network98.test.ts) |
| C2 | important | the connection list ("Shared AI results") | Says readings of a public datasheet are shared; the code shares the reading of any datasheet, one given by hand included | **fixed**: shared only when the datasheet came from the web; the list, the guide and the website say so |
| C3 | important | src/app/panels/ScriptsPanel.tsx | A script of one's own is deleted at one click | **fixed**: asked first |
| C4 | minor | the guide's short table | "AI: only when you start a job"; a panel asks for the list of models when it opens | **fixed**: the table says so |
| C5 | minor | Vcs.tsx, StorageManager.tsx, pcbFields.tsx | A late answer shown under another version; an empty box counted as 0 in Purge History; a length past 32 bits wraps | **fixed**: the late answer is dropped, an empty box is refused, a length a board file cannot hold is refused |

Statements about other products (KiCad, EasyEDA) are made only from the pages of their own
documentation linked beside them (website/site.mjs, SOURCES).

## 6. Swept for across the whole code

By kind of fault, in every file under src/, cloudflare/, website/ and public/:

| What was looked for | How | Found |
|---|---|---|
| Markup written from data | Every `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `srcdoc`, and every whole page the program writes (ten) | I1, I3, I4 above; every written page given a policy that lets nothing in it run |
| Text that could become an element | Every message listener; every place a structured copy from outside the page is shown | I2 above (the script frame's is the only listener that hears a stranger) |
| Addresses from data that could run | Every link and `window.open` whose address is not fixed | The Parts panel's datasheet link now goes through the same check as the others |
| Requests | Every `fetch`, script, worker, picture and frame the program can load | All gated and listed; the offline policy completed (C1) |
| Where files are written | Every use of a name from a document as a file's or a folder's name | None: the browser's file access refuses a name that leaves its folder, and a project's output path with `..` in it falls back to the usual folder |
| Archives and containers | The compound-file, ZIP and inflate readers, for loops without end and sizes taken on trust | Chains and directories are guarded against cycles; an entry that would unpack past 1 GB is now refused |
| Private matter | Every tracked file, for addresses, local paths, keys, session links, and names of real people, companies and projects | P2 above |
| Other people's work | Every package the build takes in; every comment that names another project's code or data | P4, P8 above; docs/PROVENANCE.md |
| The site's own answers | The headers the site sends; the website's own scripts | No page may be framed by another site or taken for another kind of file (new); the scripts write text only |

Not swept, and said so that nobody takes it for covered: faults of arithmetic or geometry in the
readers, writers and analyses that the tests do not reach. A crafted file can at worst make a
reader stop with an error or the tab run out of memory; it cannot reach the page's markup, the
network or other files by any path found.

## Before the repository is made public

The services are deployed with their fixes first: until then the published source would show
holes that are still open on the live services.
