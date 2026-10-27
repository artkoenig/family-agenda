---
status: proposed
---

# Tesseract models are downloaded at run time into a volume

Scanned letters are read with Tesseract when the LLM endpoint does not read images, and Tesseract reads only the languages it has a model for. Families get letters in other languages than the Family Language, and Tesseract has models for more than 120 languages. Shipping all of them would make the image several hundred megabytes larger, and shipping only some would leave Families without a way to add theirs.

The image ships the `deu`, `eng` and `osd` models of its Debian packages. On every start, `api` and `worker` link them into a `tessdata` volume where they are missing, and pass that volume to Tesseract with `--tessdata-dir`. An Admin installs further languages from the settings: the `api` downloads the model from `tesseract-ocr/tessdata_fast` at a pinned commit and checks its SHA-256 against a list shipped with the image (`packages/adapters/tessdata/tessdata-fast.sha256`). A file that fails to download or does not match is not kept. An Admin can remove a downloaded model unless OCR reads in it; the bundled ones stay. An Instance without internet access gets a model by an operator putting its `.traineddata` file into the volume by hand.

## Consequences

- The pinned commit (`tessdataFastCommit` in `packages/adapters/src/tessdata-fast-catalog.ts`) and the checksum list change together. To move to a newer commit, clone `tessdata_fast` at it, run `sha256sum *.traineddata` and replace the list's entries with the output.
- A downloaded model is code-adjacent data from the internet that Tesseract parses. The checksum ties it to the reviewed commit, so a compromised download host or a tampered response cannot slip in another file.
- The volume need not be backed up: the bundled models are linked again on start, and the others can be downloaded again.
- When an OCR language chosen in the settings has no model at run time, such as after an operator removed it, scanned attachments are not read and their mail says why. Tesseract does not silently fall back to the other languages, since a letter read in the wrong language looks plausible and is wrong.

## Considered Options

- **`tessdata_best` instead of `tessdata_fast`**: slightly more accurate, but its models are several times larger and OCR with them several times slower, which matters on a Raspberry Pi reading a ten-page scan. The models Debian ships are the fast ones, so bundled and downloaded models also read alike.
- **All Debian `tesseract-ocr-*` packages in the image**: no downloads, but every Instance carries every language.
- **Installing packages at run time with `apt`**: needs root in the container, and is lost when the container is recreated.
- **Downloads without checksums, trusting HTTPS and the pinned commit**: whoever can alter the response, such as a proxy that intercepts TLS, could hand Tesseract another file.
