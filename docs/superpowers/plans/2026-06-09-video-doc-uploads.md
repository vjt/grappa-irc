# Video + Document Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Video + document uploads in cic with client-side adaptive H.264 transcode (mediabunny/WebCodecs), per-type server caps, #49 fixed, Plug.Parsers latent 8MB bug fixed.

**Architecture:** Generalize `ImageHost` → `UploadHost` with per-category (`image|video|document`) accept lists + caps; single orchestrator gains a pre-upload transform hook (video → transcode, else identity). Server: per-type cap keys in ServerSettings (DML key migration), MIME→category map in UploadsController. Spec: `docs/superpowers/specs/2026-06-09-video-doc-uploads-design.md` — read it first; all decisions live there.

**Tech Stack:** Elixir/Phoenix (grappa), SolidJS/TypeScript (cicchetto), mediabunny ^1.46 (new cic dep), vitest, ExUnit, Playwright.

**Worktree:** all code in a worktree branched from LOCAL main (`/home/vjt/code/IRC/grappa-task-uploads2`), per superpowers:using-git-worktrees. cic changes are commits inside the worktree's `cicchetto/` submodule on a matching branch; grappa records the new submodule SHA at merge. cic gates run via `scripts/bun.sh` (fresh worktree → `scripts/bun.sh install` first). Run `scripts/check.sh` before starting — fix pre-existing failures first.

---

### Task 1: Plug.Parsers `:length` fix (latent bug, standalone)

**Files:**
- Modify: `lib/grappa_web/endpoint.ex:69-72`
- Test: `test/grappa_web/controllers/uploads_controller_test.exs`

- [ ] **Step 1: Write the failing test**

In `uploads_controller_test.exs`, add inside the POST describe block (reuse the file's existing `setup` session + `put_bearer/2` helper — same shape as the nearest 201 test):

```elixir
test "POST /api/uploads accepts a >8MB file (Plug.Parsers :length regression)",
     %{conn: conn, session: session} do
  # 9MB < the 10MB image cap, but > Plug.Parsers' 8MB multipart
  # default. Must go through the REAL multipart parser: ConnTest
  # map-params bypass Plug.Parsers, so build a raw multipart body.
  bytes = :binary.copy(<<0>>, 9 * 1024 * 1024)
  boundary = "plugparsersregression"

  body =
    "--#{boundary}\r\n" <>
      "Content-Disposition: form-data; name=\"file\"; filename=\"big.png\"\r\n" <>
      "Content-Type: image/png\r\n\r\n" <>
      bytes <> "\r\n--#{boundary}--\r\n"

  conn =
    conn
    |> put_bearer(session.id)
    |> put_req_header("content-type", "multipart/form-data; boundary=#{boundary}")
    |> post("/api/uploads", body)

  assert %{"slug" => _} = json_response(conn, 201)
end
```

Adapt the setup-context key names (`session`) to whatever the file's `setup` block actually returns — read it before writing.

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/test.sh test/grappa_web/controllers/uploads_controller_test.exs`
Expected: FAIL — `Plug.Parsers.RequestTooLargeError` (multipart default `:length` is 8MB).

- [ ] **Step 3: Fix endpoint.ex**

```elixir
plug Plug.Parsers,
  parsers: [:urlencoded, :multipart, :json],
  pass: ["*/*"],
  # Multipart default :length is 8MB — silently below the advertised
  # per-file upload caps (10MB image / 50MB video). Static transport
  # ceiling only; the real policy lives in the admin-tunable per-type
  # caps at UploadsController. nginx is at client_max_body_size 100m.
  length: 64 * 1024 * 1024,
  json_decoder: Phoenix.json_library()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/test.sh test/grappa_web/controllers/uploads_controller_test.exs`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add lib/grappa_web/endpoint.ex test/grappa_web/controllers/uploads_controller_test.exs
git commit -m "fix(uploads): raise Plug.Parsers :length above the advertised caps

The multipart default is 8MB; a 9MB upload 413'd at the parser while
the per-file cap said 10MB. 64MB static ceiling — policy stays in the
admin-tunable per-type caps."
```

---

### Task 2: ServerSettings per-type caps + DML migration + Wire + admin PUT

**Files:**
- Modify: `lib/grappa/server_settings.ex`
- Modify: `lib/grappa/server_settings/wire.ex`
- Modify: `lib/grappa_web/controllers/admin/settings_controller.ex`
- Create: `priv/repo/migrations/<timestamp>_rename_per_file_cap_setting_to_image.exs`
- Test: `test/grappa/server_settings_test.exs`, `test/grappa_web/controllers/admin/settings_controller_test.exs` (read both first; extend in-pattern)

- [ ] **Step 1: Write failing ServerSettings tests**

```elixir
describe "per-type per-file caps" do
  test "defaults: image 10MiB, video 50MiB, document 10MiB" do
    assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 10 * 1024 * 1024
    assert ServerSettings.get_upload_per_file_cap_bytes(:video) == 50 * 1024 * 1024
    assert ServerSettings.get_upload_per_file_cap_bytes(:document) == 10 * 1024 * 1024
  end

  test "put/get roundtrip per category" do
    assert :ok = ServerSettings.put_upload_per_file_cap_bytes(:video, 25 * 1024 * 1024)
    assert ServerSettings.get_upload_per_file_cap_bytes(:video) == 25 * 1024 * 1024
    # other categories untouched
    assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 10 * 1024 * 1024
  end

  test "rejects invalid category and non-positive values" do
    assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(:image, 0)
    assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(:audio, 1)
  end

  test "public_view carries the three cap fields" do
    view = ServerSettings.public_view()
    assert %{upload: %{image_per_file_cap_bytes: _, video_per_file_cap_bytes: _,
             document_per_file_cap_bytes: _, active_host: _, global_cap_bytes: _}} = view
  end

  test "old single key is NOT read (no fallback — total migration)" do
    # Simulate a pre-migration leftover row; getters must ignore it.
    Repo.insert!(%Setting{key: "upload.per_file_cap_bytes", value: "999"})
    assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 10 * 1024 * 1024
  end
end
```

Delete/replace the existing `get_upload_per_file_cap_bytes/0` tests (the 0-arity function dies — total migration, no half-state).

- [ ] **Step 2: Run to verify failure**

Run: `scripts/test.sh test/grappa/server_settings_test.exs`
Expected: FAIL — `get_upload_per_file_cap_bytes/1 undefined`.

- [ ] **Step 3: Implement ServerSettings changes**

In `lib/grappa/server_settings.ex` — replace the single per-file key/default/get/put with:

```elixir
@key_upload_image_per_file_cap_bytes "upload.image_per_file_cap_bytes"
@key_upload_video_per_file_cap_bytes "upload.video_per_file_cap_bytes"
@key_upload_document_per_file_cap_bytes "upload.document_per_file_cap_bytes"

@default_upload_image_per_file_cap_bytes 10 * 1024 * 1024
@default_upload_video_per_file_cap_bytes 50 * 1024 * 1024
@default_upload_document_per_file_cap_bytes 10 * 1024 * 1024

@type upload_category :: :image | :video | :document
@upload_categories [:image, :video, :document]

@doc "Returns the per-file upload byte cap for `category`."
@spec get_upload_per_file_cap_bytes(upload_category()) :: pos_integer()
def get_upload_per_file_cap_bytes(:image),
  do: read_cap(@key_upload_image_per_file_cap_bytes, @default_upload_image_per_file_cap_bytes)

def get_upload_per_file_cap_bytes(:video),
  do: read_cap(@key_upload_video_per_file_cap_bytes, @default_upload_video_per_file_cap_bytes)

def get_upload_per_file_cap_bytes(:document),
  do: read_cap(@key_upload_document_per_file_cap_bytes, @default_upload_document_per_file_cap_bytes)

@doc "Pins the per-file upload byte cap for `category`. Positive integer only."
@spec put_upload_per_file_cap_bytes(upload_category(), pos_integer()) ::
        :ok | {:error, :invalid_value}
def put_upload_per_file_cap_bytes(category, n)
    when category in @upload_categories and is_integer(n) and n > 0 do
  put_raw(cap_key_for(category), Integer.to_string(n))
end

def put_upload_per_file_cap_bytes(_, _), do: {:error, :invalid_value}

defp cap_key_for(:image), do: @key_upload_image_per_file_cap_bytes
defp cap_key_for(:video), do: @key_upload_video_per_file_cap_bytes
defp cap_key_for(:document), do: @key_upload_document_per_file_cap_bytes

defp read_cap(key, default) do
  case decode_pos_int(get_raw(key)) do
    {:ok, n} -> n
    :error -> default
  end
end
```

Update `public_view/0` + its `@type public_view`:

```elixir
upload: %{
  active_host: get_upload_active_host(),
  image_per_file_cap_bytes: get_upload_per_file_cap_bytes(:image),
  video_per_file_cap_bytes: get_upload_per_file_cap_bytes(:video),
  document_per_file_cap_bytes: get_upload_per_file_cap_bytes(:document),
  global_cap_bytes: get_upload_global_cap_bytes()
}
```

Update the moduledoc key registry table (three rows replace one).

- [ ] **Step 4: Update Wire**

`lib/grappa/server_settings/wire.ex` — `upload_view/1` + `@type upload_view`:

```elixir
@type upload_view :: %{
        active_host: String.t(),
        image_per_file_cap_bytes: pos_integer(),
        video_per_file_cap_bytes: pos_integer(),
        document_per_file_cap_bytes: pos_integer(),
        global_cap_bytes: pos_integer()
      }

def upload_view(%{} = upload) do
  %{
    active_host: Atom.to_string(upload.active_host),
    image_per_file_cap_bytes: upload.image_per_file_cap_bytes,
    video_per_file_cap_bytes: upload.video_per_file_cap_bytes,
    document_per_file_cap_bytes: upload.document_per_file_cap_bytes,
    global_cap_bytes: upload.global_cap_bytes
  }
end
```

(`@spec` input map updated to match.) Verify `GrappaWeb.ServerSettingsController` (GET /api/server-settings) and `GrappaWeb.GrappaChannel.push_server_settings/1` both render via `Wire` — grep `upload_view\|server_settings_changed`; if either hand-rolls the shape, route it through Wire (one source of truth).

- [ ] **Step 5: Update Admin.SettingsController**

Replace the two `apply_upload_key("per_file_cap_bytes", ...)` clauses in `lib/grappa_web/controllers/admin/settings_controller.ex` with six:

```elixir
defp apply_upload_key("image_per_file_cap_bytes", n) when is_integer(n) and n > 0,
  do: ServerSettings.put_upload_per_file_cap_bytes(:image, n)

defp apply_upload_key("image_per_file_cap_bytes", _),
  do: {:error, {:invalid_setting, "upload.image_per_file_cap_bytes"}}

defp apply_upload_key("video_per_file_cap_bytes", n) when is_integer(n) and n > 0,
  do: ServerSettings.put_upload_per_file_cap_bytes(:video, n)

defp apply_upload_key("video_per_file_cap_bytes", _),
  do: {:error, {:invalid_setting, "upload.video_per_file_cap_bytes"}}

defp apply_upload_key("document_per_file_cap_bytes", n) when is_integer(n) and n > 0,
  do: ServerSettings.put_upload_per_file_cap_bytes(:document, n)

defp apply_upload_key("document_per_file_cap_bytes", _),
  do: {:error, {:invalid_setting, "upload.document_per_file_cap_bytes"}}
```

An old cic sending `per_file_cap_bytes` now hits the unknown-key warning clause — correct forward-compat posture (logged, not silent). Update the moduledoc body-shape examples. Extend the controller test: PUT each new key → 200 + value persisted; PUT `video_per_file_cap_bytes: -1` → 422 with `field_errors` naming the key; GET returns the three fields.

- [ ] **Step 6: DML migration**

`mix ecto.gen.migration` is banned on host — create the file by hand with a current UTC timestamp name, e.g. `priv/repo/migrations/20260609T_rename_per_file_cap_setting_to_image.exs` (verify the table name against `lib/grappa/server_settings/setting.ex` — expected `server_settings`):

```elixir
defmodule Grappa.Repo.Migrations.RenamePerFileCapSettingToImage do
  use Ecto.Migration

  # DML-only (no DDL) — hot-deployable per the #41 classifier. Renames
  # the single per-file cap key to the image-specific key; video +
  # document keys are born from code defaults, no rows needed.
  def up do
    execute("""
    UPDATE server_settings
    SET key = 'upload.image_per_file_cap_bytes'
    WHERE key = 'upload.per_file_cap_bytes'
      AND NOT EXISTS (
        SELECT 1 FROM server_settings WHERE key = 'upload.image_per_file_cap_bytes'
      )
    """)

    execute("DELETE FROM server_settings WHERE key = 'upload.per_file_cap_bytes'")
  end

  def down do
    execute("""
    UPDATE server_settings
    SET key = 'upload.per_file_cap_bytes'
    WHERE key = 'upload.image_per_file_cap_bytes'
    """)
  end
end
```

- [ ] **Step 7: Run server test suite**

Run: `scripts/test.sh`
Expected: PASS, zero warnings. Anything still calling `get_upload_per_file_cap_bytes/0` is a compile error — fix every caller (Task 3 handles UploadsController; if it breaks here, stub the category as `:image` temporarily is FORBIDDEN — do Task 3's controller change in this commit instead if compilation forces it, keeping tests green).

- [ ] **Step 8: Commit**

```bash
git add lib/grappa/server_settings.ex lib/grappa/server_settings/wire.ex \
  lib/grappa_web/controllers/admin/settings_controller.ex priv/repo/migrations/ test/
git commit -m "feat(settings): per-type upload caps (image/video/document)

One cap key per category (10/50/10 MiB defaults) replacing the single
per_file_cap_bytes; DML migration renames the existing row, no read
fallback on the old name. Wire + admin PUT carry the three fields."
```

---

### Task 3: UploadsController MIME→category map + per-category caps

**Files:**
- Modify: `lib/grappa_web/controllers/uploads_controller.ex`
- Test: `test/grappa_web/controllers/uploads_controller_test.exs`

- [ ] **Step 1: Write failing tests** (reuse existing fixtures/helpers; one happy + one cap test per new category, one 415):

```elixir
test "POST accepts video/mp4 within the 50MB video cap", %{conn: conn, session: session} do
  # 11MB: above the 10MB image cap, below the 50MB video cap —
  # proves the cap is per-category, not global.
  upload = plug_upload_fixture(:binary.copy(<<0>>, 11 * 1024 * 1024), "clip.mp4", "video/mp4")
  conn = conn |> put_bearer(session.id) |> post("/api/uploads", %{"file" => upload})
  assert %{"slug" => _} = json_response(conn, 201)
end

test "POST rejects an 11MB image (per-category cap, 413)", %{conn: conn, session: session} do
  upload = plug_upload_fixture(:binary.copy(<<0>>, 11 * 1024 * 1024), "big.png", "image/png")
  conn = conn |> put_bearer(session.id) |> post("/api/uploads", %{"file" => upload})
  assert %{"error" => "file_too_large"} = json_response(conn, 413)
end

test "POST accepts application/pdf", %{conn: conn, session: session} do
  upload = plug_upload_fixture("%PDF-1.4 fake", "doc.pdf", "application/pdf")
  conn = conn |> put_bearer(session.id) |> post("/api/uploads", %{"file" => upload})
  assert json_response(conn, 201)
end

test "POST rejects unknown MIME with 415", %{conn: conn, session: session} do
  upload = plug_upload_fixture(<<0>>, "evil.exe", "application/x-msdownload")
  conn = conn |> put_bearer(session.id) |> post("/api/uploads", %{"file" => upload})
  assert json_response(conn, 415)
end
```

`plug_upload_fixture/3` = whatever helper the file already uses to build a `%Plug.Upload{}` from bytes (read the file; if it inlines tmp-file writing, extract that into a private helper rather than copy-pasting four times). Also add 201 tests for `text/plain` and `video/quicktime` (small bodies).

- [ ] **Step 2: Run to verify failure**

Run: `scripts/test.sh test/grappa_web/controllers/uploads_controller_test.exs`
Expected: video/pdf tests FAIL with 415 (not in the current image-only allowlist).

- [ ] **Step 3: Implement**

Replace `@allowed_mimes` + `validate_mime/1` + `check_per_file_cap/1`:

```elixir
@mime_categories %{
  "image/png" => :image,
  "image/jpeg" => :image,
  "image/gif" => :image,
  "image/webp" => :image,
  "image/apng" => :image,
  "video/mp4" => :video,
  "video/quicktime" => :video,
  "video/webm" => :video,
  "application/pdf" => :document,
  "text/plain" => :document,
  "application/vnd.oasis.opendocument.text" => :document,
  "application/vnd.oasis.opendocument.spreadsheet" => :document,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => :document,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => :document
}

defp validate_mime(%Plug.Upload{content_type: ct}) when is_binary(ct) do
  case Map.fetch(@mime_categories, ct) do
    {:ok, category} -> {:ok, ct, category}
    :error -> {:error, :unsupported_media_type}
  end
end

defp validate_mime(_), do: {:error, :unsupported_media_type}

defp check_per_file_cap(bytes, category) do
  cap = ServerSettings.get_upload_per_file_cap_bytes(category)

  if byte_size(bytes) <= cap do
    :ok
  else
    {:error, {:file_too_large, cap}}
  end
end
```

In `create/2`'s `with`: `{:ok, mime, category} <- validate_mime(upload)` and `:ok <- check_per_file_cap(bytes, category)`. Category is derived, NOT stored — no schema change. Update the moduledoc boundary-checks section.

- [ ] **Step 4: Run + commit**

Run: `scripts/test.sh` → PASS. Then:

```bash
git add lib/grappa_web/controllers/uploads_controller.ex test/grappa_web/controllers/uploads_controller_test.exs
git commit -m "feat(uploads): accept video + document MIMEs with per-category caps"
```

- [ ] **Step 5: Server gates**

Run: `scripts/check.sh` (format, credo, dialyzer, sobelow). Expected: clean. Fix + amend if not.

---

### Task 4: cic — `UploadHost` generalization + serverSettings wire

**Files (all under `cicchetto/`):**
- Rename: `src/lib/image-upload.ts` → `src/lib/uploadHost.ts` (git mv, then edit)
- Modify: `src/lib/serverSettings.ts`
- Modify importers: `src/lib/imageUploadOrchestrator.ts`, `src/ComposeBox.tsx`, `src/PrivacyModal.tsx`, `src/SettingsDrawer.tsx` (grep `from "./lib/image-upload"` / `from "./image-upload"` for the full list)
- Test: `src/lib/__tests__/` — rename/extend the image-upload + serverSettings test files

- [ ] **Step 1: Write failing tests** (new file `src/lib/__tests__/uploadHost.test.ts`, migrating the old image-upload tests):

```ts
import { describe, expect, it } from "vitest";
import { categoryOf, embeddedHost, litterboxHost } from "../uploadHost";

describe("categoryOf", () => {
  it.each([
    ["image/png", "image"], ["image/jpeg", "image"], ["image/gif", "image"],
    ["image/webp", "image"], ["image/apng", "image"],
    ["video/mp4", "video"], ["video/quicktime", "video"], ["video/webm", "video"],
    ["application/pdf", "document"], ["text/plain", "document"],
    ["application/vnd.oasis.opendocument.text", "document"],
    ["application/vnd.oasis.opendocument.spreadsheet", "document"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"],
  ] as const)("%s → %s", (mime, cat) => {
    expect(categoryOf(mime)).toBe(cat);
  });

  it("unknown MIME → null", () => {
    expect(categoryOf("application/x-msdownload")).toBeNull();
  });
});

describe("per-host category lists", () => {
  it("litterbox excludes docx/xlsx (.doc* blocked host-side)", () => {
    expect(litterboxHost.acceptedMimeTypes.document).not.toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(embeddedHost.acceptedMimeTypes.document).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("embedded caps read serverSettings per category, with cold-start fallbacks", () => {
    // null signal → fallback literals (10/50/10 MB)
    expect(embeddedHost.maxFileSizeBytes("image")).toBe(10 * 1024 * 1024);
    expect(embeddedHost.maxFileSizeBytes("video")).toBe(50 * 1024 * 1024);
    expect(embeddedHost.maxFileSizeBytes("document")).toBe(10 * 1024 * 1024);
  });
});
```

Plus a serverSettings test: `applyServerSettings` with the new wire payload (`image_per_file_cap_bytes` etc.) populates `uploadPerFileCapBytes.video` etc.

- [ ] **Step 2: Run to verify failure**

Run: `scripts/bun.sh run test src/lib/__tests__/uploadHost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement uploadHost.ts**

`git mv src/lib/image-upload.ts src/lib/uploadHost.ts`, rename `ImageHost` → `UploadHost` everywhere, then:

```ts
export type UploadCategory = "image" | "video" | "document";

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/apng"] as const;
const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"] as const;
const DOCUMENT_MIMES_PORTABLE = [
  "application/pdf",
  "text/plain",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
] as const;
const DOCUMENT_MIMES_OFFICE = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

const MIME_CATEGORIES: Record<string, UploadCategory> = Object.fromEntries([
  ...IMAGE_MIMES.map((m) => [m, "image"] as const),
  ...VIDEO_MIMES.map((m) => [m, "video"] as const),
  ...DOCUMENT_MIMES_PORTABLE.map((m) => [m, "document"] as const),
  ...DOCUMENT_MIMES_OFFICE.map((m) => [m, "document"] as const),
]);

/** Single MIME→category map. null = not uploadable, reject at boundary. */
export function categoryOf(mime: string): UploadCategory | null {
  return MIME_CATEGORIES[mime] ?? null;
}
```

Interface changes (other members unchanged):

```ts
export interface UploadHost {
  // ...id, displayName, retentionStatement, ttlOptions, defaultTtl,
  // supportsProgress, upload() unchanged...
  readonly acceptedMimeTypes: Readonly<Record<UploadCategory, ReadonlyArray<string>>>;
  /** Function, not literal: the embedded host reads the reactive
   *  serverSettings() signal so admin-tuned caps apply live. */
  maxFileSizeBytes(category: UploadCategory): number | null;
}
```

`litterboxHost`:

```ts
acceptedMimeTypes: {
  image: IMAGE_MIMES,
  video: VIDEO_MIMES,
  // litterbox blocks .doc* host-side (FAQ, verified 2026-06-09) —
  // office formats are embedded-only.
  document: DOCUMENT_MIMES_PORTABLE,
},
maxFileSizeBytes: (category) =>
  ({ image: 100 * 1024 * 1024, video: 50 * 1024 * 1024, document: 10 * 1024 * 1024 })[category],
```

`embeddedHost`:

```ts
acceptedMimeTypes: {
  image: IMAGE_MIMES,
  video: VIDEO_MIMES,
  document: [...DOCUMENT_MIMES_PORTABLE, ...DOCUMENT_MIMES_OFFICE],
},
// Reactive per-category cap — falls back to the server-side defaults
// (mirrors Grappa.ServerSettings @default_upload_*_cap_bytes) before
// the WS snapshot lands.
maxFileSizeBytes: (category) =>
  serverSettings()?.uploadPerFileCapBytes[category] ??
  ({ image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, document: 10 * 1024 * 1024 })[category],
```

- [ ] **Step 4: Update serverSettings.ts**

```ts
export type ServerSettingsView = {
  uploadActiveHost: "embedded" | "litterbox";
  uploadPerFileCapBytes: Record<UploadCategory, number>;
  uploadGlobalCapBytes: number;
};

export type ServerSettingsWirePayload = {
  upload: {
    active_host: "embedded" | "litterbox";
    image_per_file_cap_bytes: number;
    video_per_file_cap_bytes: number;
    document_per_file_cap_bytes: number;
    global_cap_bytes: number;
  };
};

const applyServerSettings = (raw: ServerSettingsWirePayload): void => {
  setServerSettings({
    uploadActiveHost: raw.upload.active_host,
    uploadPerFileCapBytes: {
      image: raw.upload.image_per_file_cap_bytes,
      video: raw.upload.video_per_file_cap_bytes,
      document: raw.upload.document_per_file_cap_bytes,
    },
    uploadGlobalCapBytes: raw.upload.global_cap_bytes,
  });
};
```

(`UploadCategory` import from `./uploadHost` would be a cycle — uploadHost imports serverSettings. Move `UploadCategory` + `categoryOf` into serverSettings? No: define `UploadCategory` in a tiny new `src/lib/uploadCategory.ts` exporting the type, `categoryOf`, and the MIME lists; both uploadHost.ts and serverSettings.ts import from it. Cycle dies.)

- [ ] **Step 5: Fix importers + run full cic suite**

Update every `image-upload` import to `uploadHost` (and `ImageHost` → `UploadHost`); `ComposeBox.tsx:193` accept becomes the category union (full code in Task 7 — for THIS commit just make it compile: `Object.values(activeHost().acceptedMimeTypes).flat().join(",")`); `preCheck` in the orchestrator updated in Task 5 — for this commit adapt its two call sites mechanically (`host.acceptedMimeTypes[categoryOf(file.type) ?? "image"]`-style hacks are FORBIDDEN; do the minimal honest edit: preCheck takes the category, returns error when null).

Run: `scripts/bun.sh run test` → all green (1798 baseline + new).
Run: `scripts/bun.sh run build` → the REAL type gate, must pass.
Run: `scripts/bun.sh run check` → biome (17 pre-existing warnings tolerated, no new ones).

- [ ] **Step 6: Commit (in cicchetto submodule)**

```bash
git add -A
git commit -m "refactor(upload): ImageHost → UploadHost with per-category accept + caps

categoryOf() is the single MIME→category map; embedded caps read the
reactive serverSettings signal per category. Wire shape: three cap
fields replace per_file_cap_bytes (lockstep with the server change)."
```

---

### Task 5: cic — orchestrator transform hook + #49 fix

**Files (cicchetto):**
- Rename: `src/lib/imageUploadOrchestrator.ts` → `src/lib/uploadOrchestrator.ts`
- Test: `src/lib/__tests__/uploadOrchestrator.test.ts` (migrate existing orchestrator tests)

- [ ] **Step 1: Write failing tests**

```ts
describe("category dispatch", () => {
  it("document upload sends 📄-prefixed URL", async () => {
    // mock host.upload → resolves "https://x/doc"; trigger with a pdf File
    // assert sendMessage called with "📄 https://x/doc"
  });

  it("unknown MIME sets a pre-check error and never calls upload", async () => {
    // trigger with type "application/x-msdownload"
    // assert uploadState(key).error mentions supported types; host.upload not called
  });
});

describe("#49 — stale retry buffer", () => {
  it("retry after a pre-check rejection retries the REJECTED file, not a prior one", async () => {
    // 1. upload small.png → resolves (lastAttempt = small.png)
    // 2. trigger big.png (oversize → pre-check error entry)
    // 3. retryUpload(key)
    // assert the attempted file is big.png (fails pre-check again),
    // NOT small.png (which would silently upload the wrong file)
  });

  it("new selection after a failed POST replaces the payload", async () => {
    // 1. trigger a.png → host.upload rejects {kind:"http",status:413}
    // 2. trigger b.png → host.upload resolves
    // assert the uploaded file in step 2 is b.png and the error entry cleared
  });
});
```

Write these as real tests against the module's public surface (`triggerUpload`, `retryUpload`, `uploadState`), mocking `activeHost()` per the existing orchestrator test file's pattern — read it first and reuse its host-mock helper.

- [ ] **Step 2: Run to verify failure**

Run: `scripts/bun.sh run test src/lib/__tests__/uploadOrchestrator.test.ts`
Expected: FAIL (📄 path missing; #49 retry test reproduces the stale buffer).

- [ ] **Step 3: Implement**

`git mv`, then in `uploadOrchestrator.ts`:

```ts
import { activeHost, type UploadHost } from "./uploadHost";
import { categoryOf, type UploadCategory } from "./uploadCategory";

const CATEGORY_EMOJI: Record<UploadCategory, string> = {
  image: "📸",
  video: "🎬",
  document: "📄",
};

export type UploadStateEntry = {
  filename: string;
  phase: "transcoding" | "uploading";
  loaded: number;
  total: number;
  error?: string;
};
```

`dispatchUpload` becomes the single pipeline (async; the video transform slot lands in Task 6 — this commit wires categories + #49, with the transform hook present but only the identity branch):

```ts
async function dispatchUpload(
  key: ChannelKey,
  networkSlug: string,
  channelName: string,
  file: File,
): Promise<void> {
  const host = activeHost();

  // #49 root fix: lastAttempt is the user's LATEST selection,
  // recorded unconditionally before any gate can reject — retry
  // always retries what the error box shows, and a new selection
  // always replaces a rejected one.
  lastAttempt.set(key, { file, networkSlug, channelName });

  const category = categoryOf(file.type);
  if (category === null || !host.acceptedMimeTypes[category].includes(file.type)) {
    setEntry(key, {
      filename: file.name, phase: "uploading", loaded: 0, total: 0,
      error: unsupportedTypeMessage(host),
    });
    return;
  }

  // Transform hook — video transcode lands in Task 6; image/document
  // pass through.
  const uploadFile = file;

  const cap = host.maxFileSizeBytes(category);
  if (cap !== null && uploadFile.size > cap) {
    const mb = Math.round(cap / (1024 * 1024));
    setEntry(key, {
      filename: file.name, phase: "uploading", loaded: 0, total: 0,
      error: `File is too large (max ${mb}MB).`,
    });
    return;
  }

  // ...existing inflight/controller/progress/upload flow, with
  // `phase: "uploading"` in every setEntry and the resolve branch:
  void sendMessage(networkSlug, channelName, `${CATEGORY_EMOJI[category]} ${url}`);
}
```

`unsupportedTypeMessage(host)` generalizes the old image-only string:

```ts
function unsupportedTypeMessage(host: UploadHost): string {
  const exts = Object.values(host.acceptedMimeTypes).flat()
    .map(mimeToExtLabel).join(", ");
  return `Unsupported file type (allowed: ${exts}).`;
}
```

with a small `mimeToExtLabel` map (png, jpg, gif, webp, apng, mp4, mov, webm, pdf, txt, odt, ods, docx, xlsx). The old `preCheck/2` dies — its two checks moved inline above (type check needs `category`, cap check needs the post-transform file; one function can no longer serve both moments).

`triggerUpload` stays sync-shaped (`void dispatchUpload(...)` where needed). Keep the privacy-modal, cancel, dismiss, retry surfaces as they are.

- [ ] **Step 4: Run cic gates + commit**

Run: `scripts/bun.sh run test` → PASS; `run build` → PASS.

```bash
git add -A
git commit -m "feat(upload): category-dispatched orchestrator + #49 stale-retry fix

Single pipeline: categoryOf → accept gate → (transform hook) → cap →
upload → emoji-prefixed PRIVMSG. lastAttempt now records the latest
selection unconditionally, so retry retries what the error box shows.
Fixes #49."
```

---

### Task 6: cic — `videoTranscode.ts` + mediabunny + orchestrator video branch

**Files (cicchetto):**
- Modify: `package.json` (mediabunny dep)
- Create: `src/lib/videoTranscode.ts`
- Modify: `src/lib/uploadOrchestrator.ts` (video branch in the transform hook)
- Test: `src/lib/__tests__/videoTranscode.test.ts`, extend `uploadOrchestrator.test.ts`

- [ ] **Step 1: Install dep**

Run: `scripts/bun.sh add mediabunny`
Then: open `node_modules/mediabunny/dist/` type declarations and VERIFY the exact export names used below (`Input`, `Output`, `Conversion`, `BlobSource`, `BufferTarget`, `Mp4OutputFormat`, `ALL_FORMATS`, `canEncodeVideo`) — adjust the module code to the real API before writing tests. The shapes below are from the 1.46 docs; trust the package's types over this plan.

- [ ] **Step 2: Write failing tests** (mediabunny mocked at the module boundary with `vi.mock("mediabunny", ...)` — jsdom has no WebCodecs; we test OUR policy, not their codec):

```ts
describe("videoTranscodeSupported", () => {
  it("false when VideoEncoder is undefined", async () => { /* default jsdom */ });
  it("true when VideoEncoder exists and canEncodeVideo resolves true", async () => {
    vi.stubGlobal("VideoEncoder", class {});
    // mocked canEncodeVideo → true
  });
  // cp60 gotcha: restore stubs in afterEach, NEVER unstubAllGlobals in beforeEach.
});

describe("resolution policy", () => {
  it.each([
    [30, 720],   // 30s → ~13Mbps budget → 720p
    [110, 720],  // 110s → ~3.4Mbps → 720p
    [119, 720],  // edge under the 2' line
  ])("duration %ss picks %sp", (duration, height) => {
    expect(pickTargetHeight(duration, 50 * 1024 * 1024)).toBe(height);
  });

  it("picks 480p when the bitrate budget drops below threshold", () => {
    // tiny cap forces the budget under 2Mbps
    expect(pickTargetHeight(110, 4 * 1024 * 1024)).toBe(480);
  });
});

describe("transcodeVideo", () => {
  it("rejects > 120s with too_long before any conversion", async () => { /* mock duration probe */ });
  it("returns {error:{kind:'unsupported'}} when the gate is closed", async () => {});
  it("propagates cancel via AbortSignal", async () => {});
});
```

Export `pickTargetHeight` for direct testing (pure function — policy in data, not buried).

- [ ] **Step 3: Implement `src/lib/videoTranscode.ts`**

```ts
// Client-side video downscale — uploads-2 cluster (2026-06-09).
//
// mediabunny (WebCodecs under the hood): demux mp4/mov/webm →
// H.264 mp4 out, audio passthrough when the source track fits the
// container (the iPhone AAC case — Chrome has no AAC encoder).
// Transcode-always when supported: output is uniformly mp4 and
// metadata-free (fresh container; GPS/EXIF die by construction).
// Spec: docs/superpowers/specs/2026-06-09-video-doc-uploads-design.md
import {
  ALL_FORMATS, BlobSource, BufferTarget, canEncodeVideo,
  Conversion, Input, Mp4OutputFormat, Output,
} from "mediabunny";

export type TranscodeError =
  | { kind: "too_long"; durationSeconds: number } // policy — hard reject, no fallback
  | { kind: "unsupported" }                       // capability — fallback eligible
  | { kind: "failed"; message: string };          // capability — fallback eligible

export const MAX_DURATION_SECONDS = 120;
export const RESOLUTION_THRESHOLD_BPS = 2_000_000;
const AUDIO_BUDGET_BPS = 128_000;
const CAP_SAFETY = 0.95; // VBR overshoot margin

let cachedSupport: boolean | null = null;

export async function videoTranscodeSupported(): Promise<boolean> {
  if (cachedSupport !== null) return cachedSupport;
  if (typeof VideoEncoder === "undefined") {
    cachedSupport = false;
    return false;
  }
  cachedSupport = await canEncodeVideo("avc");
  return cachedSupport;
}

/** Duration via <video> loadedmetadata — works WITHOUT WebCodecs, so
 *  the 2-minute policy gate also applies on the fallback path. */
export function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(el.duration) ? el.duration : null);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    el.src = url;
  });
}

/** Pure policy: bitrate budget = (95% cap × 8)/duration − audio;
 *  ≥ threshold → 720p, else 480p. */
export function pickTargetHeight(durationSeconds: number, capBytes: number): 720 | 480 {
  const budget = (capBytes * CAP_SAFETY * 8) / durationSeconds - AUDIO_BUDGET_BPS;
  return budget >= RESOLUTION_THRESHOLD_BPS ? 720 : 480;
}

export async function transcodeVideo(
  file: File,
  capBytes: number,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<{ ok: File } | { error: TranscodeError }> {
  if (!(await videoTranscodeSupported())) return { error: { kind: "unsupported" } };

  const duration = await probeDuration(file);
  if (duration === null) return { error: { kind: "failed", message: "unreadable metadata" } };
  if (duration > MAX_DURATION_SECONDS) {
    return { error: { kind: "too_long", durationSeconds: duration } };
  }

  const targetHeight = pickTargetHeight(duration, capBytes);
  const videoBitrate =
    (capBytes * CAP_SAFETY * 8) / duration - AUDIO_BUDGET_BPS;

  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      video: { height: targetHeight, fit: "contain", bitrate: Math.floor(videoBitrate) },
      // audio: default — copy when compatible, re-encode when the
      // platform can, discard otherwise (caller proceeds video-only).
    });
    signal.addEventListener("abort", () => void conversion.cancel());
    conversion.onProgress = (p: number) => onProgress(p);
    await conversion.execute();
    const buffer = (output.target as BufferTarget).buffer;
    if (buffer === null) return { error: { kind: "failed", message: "empty output" } };
    const name = file.name.replace(/\.[^.]+$/, "") + ".mp4";
    return { ok: new File([buffer], name, { type: "video/mp4" }) };
  } catch (e) {
    if (signal.aborted) return { error: { kind: "failed", message: "aborted" } };
    return { error: { kind: "failed", message: e instanceof Error ? e.message : String(e) } };
  }
}
```

Note: mediabunny "never upscales" on its own when the source is below target (`fit` + missing dimension deduction) — verify against its types; if not, clamp `targetHeight` to the source height read from `input` track metadata.

- [ ] **Step 4: Wire the video branch into the orchestrator transform hook**

In `uploadOrchestrator.ts`, replace `const uploadFile = file;` with:

```ts
let uploadFile = file;
if (category === "video") {
  const prepared = await prepareVideo(key, host, file, controller.signal);
  if (prepared === null) return; // error entry already set
  uploadFile = prepared;
}
```

(`controller` — the AbortController — moves UP before the transform so cancelUpload aborts an in-flight transcode too; `inflight.set(key, ...)` moves with it.) And:

```ts
/** Video transform: transcode when supported; on capability errors
 *  fall back to the ORIGINAL (≤ 2' and ≤ cap — vjt 2026-06-09,
 *  compatibility over metadata hygiene; the leak is documented in
 *  the spec). Policy errors (too_long) never fall back. Returns the
 *  file to upload, or null after setting the error entry. */
async function prepareVideo(
  key: ChannelKey,
  host: UploadHost,
  file: File,
  signal: AbortSignal,
): Promise<File | null> {
  const cap = host.maxFileSizeBytes("video");
  setEntry(key, { filename: file.name, phase: "transcoding", loaded: 0, total: 1 });

  const result = await transcodeVideo(file, cap ?? Number.MAX_SAFE_INTEGER, (fraction) => {
    setEntry(key, { filename: file.name, phase: "transcoding", loaded: fraction, total: 1 });
  }, signal);

  if ("ok" in result) return result.ok;

  if (result.error.kind === "too_long") {
    setEntry(key, {
      filename: file.name, phase: "transcoding", loaded: 0, total: 0,
      error: "Video too long (max 2 minutes).",
    });
    return null;
  }

  // Capability failure → original-upload fallback. Console, not
  // swallowed: dogfood diagnosis needs the reason.
  console.warn("video transcode unavailable, uploading original:", result.error);
  const duration = await probeDuration(file);
  if (duration !== null && duration > MAX_DURATION_SECONDS) {
    setEntry(key, {
      filename: file.name, phase: "transcoding", loaded: 0, total: 0,
      error: "Video too long (max 2 minutes).",
    });
    return null;
  }
  return file; // cap check downstream rejects oversize originals
}
```

Orchestrator tests to extend: video happy path (mock transcodeVideo → ok file; assert 🎬 + transcoded file uploaded); too_long (no upload); unsupported → original uploaded when small, cap error when oversize; cancel during transcode clears state.

- [ ] **Step 5: Run cic gates + commit**

`scripts/bun.sh run test` + `run build` → PASS.

```bash
git add -A
git commit -m "feat(upload): client-side adaptive video transcode via mediabunny

Adaptive 720p/480p by bitrate budget under the video cap, 2' policy
ceiling (enforced on the fallback path too via <video> metadata),
audio passthrough, transcode-always when supported (metadata dies
with the container). Capability failures fall back to the original."
```

---

### Task 7: cic — ComposeBox triggers + phases UI + AdminSettingsTab

**Files (cicchetto):**
- Modify: `src/ComposeBox.tsx` (accept attr ~line 193, drop gate ~105, paste gate ~115, progress block ~261-287)
- Modify: `src/AdminSettingsTab.tsx` (one cap input → three)
- Test: `src/__tests__/ComposeBox.test.tsx`, `src/__tests__/AdminSettingsTab.test.tsx`

- [ ] **Step 1: Failing tests** — ComposeBox: drop/paste of a `video/mp4` File reaches `triggerUpload` (today filtered by `startsWith("image/")`); progress block shows "processing video…" when `phase === "transcoding"`. AdminSettingsTab: three labelled cap inputs (`admin-settings-image-cap`, `-video-cap`, `-document-cap` testids), PUT body carries the three keys in bytes.

- [ ] **Step 2: ComposeBox changes**

```tsx
// drop handler (~105) and paste handler (~115): replace
//   if (!file.type.startsWith("image/")) return;
// with
   if (categoryOf(file.type) === null) return;

// accept attr (~193):
   accept={Object.values(activeHost().acceptedMimeTypes).flat().join(",")}

// progress block (~266): phase-aware label
   <div class="compose-box-upload-progress" role="progressbar">
     <span class="compose-box-upload-filename">{st().filename}</span>
     <Show when={st().phase === "transcoding"}>
       <span class="compose-box-upload-phase">processing video…</span>
     </Show>
     <progress value={st().loaded} max={st().total} />
     <button type="button" onClick={onCancelUpload}>cancel</button>
   </div>
```

- [ ] **Step 3: AdminSettingsTab** — replace the single `perFileCapMB` signal/input with three (`imageCapMB`, `videoCapMB`, `documentCapMB`), hydrate from `view.upload.{image,video,document}_per_file_cap_bytes / MIB`, PUT `{image,video,document}_per_file_cap_bytes: Math.round(x * MIB)`, three inputs cloned from the existing per-file input markup (label, testid, field-error binding per key). Field-error keys: `upload.image_per_file_cap_bytes` etc.

- [ ] **Step 4: Gates + commit**

`scripts/bun.sh run test` + `run build` + `run check` → green.

```bash
git add -A
git commit -m "feat(cic): video+doc triggers, transcode phase UI, per-type cap admin inputs"
```

---

### Task 8: e2e + docs + merge + deploy + dogfood

**Files:**
- Create: `cicchetto/e2e/fixtures/upload.txt`, `cicchetto/e2e/fixtures/tiny.mp4` (~1s, generate once with any encoder and commit the binary)
- Modify: e2e upload spec (find it: `grep -rl "fileToUpload\|uploads" cicchetto/e2e/*.spec.ts`)
- Modify: `docs/DESIGN_NOTES.md` (cluster entry), `todo.md` (#49 done)

- [ ] **Step 1: e2e** — document happy path: pick `upload.txt` via the file input, assert a `📄 `-prefixed message lands in scrollback. Video: chromium-only test with `tiny.mp4`, `test.skip(await page.evaluate(() => typeof VideoEncoder === "undefined"))`, assert 🎬 message. No webkit-iphone video attempts (Playwright webkit ≠ iOS).

Run: `scripts/integration.sh` — triage per docs/TESTING.md (cascade vs flake, `--repeat-each` iso-rerun).

- [ ] **Step 2: DESIGN_NOTES entry** — date-stamped section: per-type caps + key migration, UploadHost generalization, mediabunny pick (and why not ffmpeg.wasm / hand-rolled), transcode-always + fallback-original decision trail (vjt reverted strict-reject for compatibility; metadata leak documented, #39 will generalize), #49 root cause (lastAttempt set only after preCheck) + fix. Close #49 via commit message keyword or `gh issue close 49 --comment` after merge.

- [ ] **Step 3: Full gates on the worktree**

`scripts/check.sh` + `scripts/test.sh` + cic `run test`/`run build` — ALL green, zero warnings.

- [ ] **Step 4: Code review** — invoke superpowers:requesting-code-review (never optional per CLAUDE.md). Fix findings, commit.

- [ ] **Step 5: Merge + deploy**

```bash
# cic first: merge the cicchetto branch to cic main (in the submodule),
# then from the grappa worktree: git rebase main; from /srv/grappa:
git merge --ff-only <branch>
git push origin main   # push BEFORE deploy-m42
scripts/deploy.sh      # local pi deploy (auto hot-vs-cold; migration is DML → hot OK)
scripts/deploy-m42.sh --cic
```

Verify health per docs/OPERATIONS.md; check the migration ran (`scripts/db.sh` → `SELECT key FROM server_settings`).

- [ ] **Step 6: iPhone dogfood (vjt)** — real Safari iOS: HEVC camera video (rotation! portrait), >2' rejection copy, transcode progress, resulting 🎬 link plays on another device; a pdf + a docx; admin cap tuning reflects live. Report results before closing the cluster checkpoint.

---

## Self-review notes (done at plan time)

- Spec coverage: every spec section maps to a task (1→Plug.Parsers; 2-3→server; 4→UploadHost+wire; 5→orchestrator+#49; 6→transcode; 7→UI; 8→e2e/docs/deploy). Privacy modal intentionally unchanged (spec: "single shared machinery").
- mediabunny API names flagged as verify-on-install (Task 6 Step 1) — the one knowingly soft spot; everything else is written against code read 2026-06-09.
- Type consistency: `UploadCategory` lives in `uploadCategory.ts` (cycle-breaker, Task 4 Step 4); `maxFileSizeBytes` is a FUNCTION of category everywhere (interface, both hosts, orchestrator, tests).
