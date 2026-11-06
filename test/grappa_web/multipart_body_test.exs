defmodule GrappaWeb.MultipartBodyTest do
  # issue 2529 — a multipart body is parsed by the route that takes it, in
  # the router, after authentication. The endpoint's `Plug.Parsers` has no
  # multipart parser, so such a body crosses it unread. A route that takes
  # one pipes through `:upload_body` (the three doors whose body a per-file
  # cap polices, up to `MultipartLimits.upload_length/0`) or
  # `:multipart_body` (anything else, up to `MultipartLimits.default_length/0`).
  #
  # The price of that design: a route that takes a file but forgets its
  # pipeline gets `params` without the body, silently. The first describe
  # makes that loud for the shape every file route here has — the action,
  # or a function of its own module it calls, matches `%Plug.Upload{}`. It
  # does NOT see a file taken only through another module's function, or
  # matched as a bare map (`%{path: _}`) without the struct.
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.ServerSettings
  alias GrappaWeb.MultipartLimits

  @mib 1024 * 1024

  # The three actions whose multipart body is policed by a per-file upload
  # cap (`ServerSettings.get_upload_per_file_cap_bytes/1`): every category
  # through `POST /api/uploads`, the largest of them plus the GCM tag
  # through `POST /api/uploads/encrypted` (issue 2517), and `:image`
  # through the own-avatar door.
  @upload_actions [
    {GrappaWeb.UploadsController, :create},
    {GrappaWeb.UploadsController, :create_encrypted},
    {GrappaWeb.NetworksController, :avatar}
  ]

  @parser_pipelines [:upload_body, :multipart_body]
  @boundary "grappa-2529-boundary"

  # One body just over the real default ceiling, built once: allocating it
  # per test would multiply the cost. An image part, so it is refused by
  # the `:image` cap on the plain and avatar doors (10 MiB by default), and
  # by its own cap on the encrypted one — a refusal only a controller that
  # received the parsed file can give.
  setup_all do
    file = :binary.copy(<<0>>, MultipartLimits.default_length() + @mib)
    %{over_default: multipart_body(file)}
  end

  describe "a route that takes a file parses it, after authentication" do
    # Driven from the compiled code, not from a list: an action "takes a
    # file" when it, or a function of its own module it reaches (a local
    # call, a `&fun/n` capture, a `__MODULE__.fun(...)` call), mentions
    # `Plug.Upload` (a `%Plug.Upload{}` match in a param or a helper).
    test "a route has a multipart parser exactly when its action can receive a %Plug.Upload{}" do
      for route <- controller_routes() do
        takes_file? = receives_upload?(route.plug, route.plug_opts)
        pipes = pipe_through(route)
        parser? = Enum.any?(pipes, &(&1 in @parser_pipelines))

        assert takes_file? == parser?,
               "#{describe(route)}: action receives a %Plug.Upload{}? #{takes_file?}, " <>
                 "pipes through a multipart parser? #{parser?} (#{inspect(pipes)})"
      end
    end

    test "every multipart parser runs after :authn" do
      for route <- controller_routes(),
          pipes = pipe_through(route),
          parser <- pipes,
          parser in @parser_pipelines do
        authn = Enum.find_index(pipes, &(&1 == :authn))
        at = Enum.find_index(pipes, &(&1 == parser))

        assert authn != nil and authn < at,
               "#{describe(route)}: #{parser} must come after :authn in #{inspect(pipes)}"
      end
    end

    # A pipeline holds its `Plug.Parsers` options as a literal in the
    # compiled router (`plug` options are evaluated at compile time), so the
    # number read here is the one each pipeline parses with — a literal
    # typed into router.ex instead of the `MultipartLimits` call shows up.
    test "each multipart pipeline parses up to its own ceiling" do
      router = definitions(GrappaWeb.Router)
      upload = integers(Map.fetch!(router, {:upload_body, 2}))
      multipart = integers(Map.fetch!(router, {:multipart_body, 2}))

      assert MultipartLimits.upload_length() in upload and MultipartLimits.default_length() not in upload,
             ":upload_body carries #{inspect(upload)}"

      assert MultipartLimits.default_length() in multipart and MultipartLimits.upload_length() not in multipart,
             ":multipart_body carries #{inspect(multipart)}"
    end

    test "only the per-file-capped actions get the upload ceiling" do
      for route <- controller_routes() do
        upload_body? = :upload_body in pipe_through(route)

        assert upload_body? == upload_route?(route),
               "#{describe(route)}: pipes :upload_body? #{upload_body?}"
      end
    end

    # Without this the tests above pass vacuously for an action that is no
    # longer routed at all.
    test "every upload action is routed" do
      routed = Enum.map(GrappaWeb.Router.__routes__(), &{&1.plug, &1.plug_opts})

      for action <- @upload_actions do
        assert action in routed, "#{inspect(action)} is no longer routed"
      end
    end
  end

  describe "the real ceilings, through the endpoint" do
    setup do
      {_, session} = user_and_session([])
      %{session: session}
    end

    test "POST /api/uploads reads a body past the default ceiling", %{
      conn: conn,
      session: session,
      over_default: body
    } do
      conn = conn |> put_bearer(session.id) |> send_multipart(:post, "/api/uploads", body)

      assert json_response(conn, 413) == %{
               "error" => "file_too_large",
               "max_bytes" => ServerSettings.get_upload_per_file_cap_bytes(:image)
             }
    end

    # Refused by the encrypted door's own cap (the largest category cap plus
    # the 16-byte GCM tag), a refusal only a controller that received the
    # parsed file can give.
    test "POST /api/uploads/encrypted reads a body past the default ceiling", %{
      conn: conn,
      session: session,
      over_default: body
    } do
      conn = conn |> put_bearer(session.id) |> send_multipart(:post, "/api/uploads/encrypted", body)

      assert json_response(conn, 413) == %{
               "error" => "file_too_large",
               "max_bytes" => GrappaWeb.UploadsController.encrypted_per_file_cap_bytes()
             }
    end

    # The port is a dummy: nothing here dials the network.
    test "PUT /networks/:id/avatar reads a body past the default ceiling", %{
      conn: conn,
      over_default: body
    } do
      {user, network, _} = user_with_credential(6667, %{})

      conn =
        conn
        |> put_bearer(session_fixture(user).id)
        |> send_multipart(:put, "/networks/#{network.slug}/avatar", body)

      assert json_response(conn, 413) == %{
               "error" => "file_too_large",
               "max_bytes" => ServerSettings.get_upload_per_file_cap_bytes(:image)
             }
    end

    test "POST /themes/background stops the same body at the default ceiling", %{
      conn: conn,
      session: session,
      over_default: body
    } do
      assert_error_sent :request_entity_too_large, fn ->
        conn |> put_bearer(session.id) |> send_multipart(:post, "/themes/background", body)
      end
    end

    # Without a bearer the body is never read: the parser sits after
    # :authn, and the endpoint has none. Before issue 2529 the endpoint
    # parsed every multipart body and this answered 413 on the two routes
    # that existed then.
    test "without a bearer the body is not read, whatever its size", %{
      conn: conn,
      over_default: body
    } do
      for path <- ["/api/uploads", "/api/uploads/encrypted", "/themes/background"] do
        assert conn |> send_multipart(:post, path, body) |> json_response(401)
      end
    end
  end

  describe "the two numbers" do
    test "every route but the upload doors keeps the 128 MiB ceiling" do
      assert MultipartLimits.default_length() == 128 * @mib
    end

    # A file exactly at the largest settable cap must fit with its multipart
    # framing (boundary lines, part headers, the small sibling fields), or
    # the cap is once again policy the transport cannot reach.
    test "the upload ceiling clears the largest settable cap with room for the framing" do
      assert MultipartLimits.upload_length() >=
               ServerSettings.max_upload_per_file_cap_bytes() + @mib
    end
  end

  describe "the in-repo nginx configs carry the same two ceilings" do
    # The two in-repo nginx files that set a body ceiling: the snippet every
    # nginx substrate includes, and the TLS front door modelled on m42's.
    @nginx_confs ["infra/snippets/locations-api.conf", "infra/nginx-tls-frontend.example.conf"]

    test "the doors' locations carry the upload ceiling and every other directive the default" do
      for conf <- @nginx_confs do
        {doors, rest} = conf |> File.read!() |> nginx_ceilings(conf)

        assert length(doors) == length(@upload_actions),
               "#{conf}: expected one upload location per door, got #{inspect(doors)}"

        for {location, mib} <- doors do
          assert mib * @mib == MultipartLimits.upload_length(),
                 "#{conf}: #{inspect(location)} carries #{mib}m"
        end

        assert rest != [], "#{conf}: no default client_max_body_size"

        for mib <- rest do
          assert mib * @mib == MultipartLimits.default_length(),
                 "#{conf}: a default client_max_body_size is #{mib}m"
        end
      end
    end

    # Nested, they inherit `location /`'s proxy headers (Host,
    # X-Forwarded-For, which RemoteIpFromProxy reads). At server level they
    # would not.
    test "the doors' locations sit inside a `location /` block" do
      for conf <- @nginx_confs do
        source = conf |> File.read!() |> strip_nginx_comments()
        spans = root_location_spans(source)

        assert spans != [], "#{conf}: no `location /` block"

        for [{at, _} | _] <- Regex.scan(door_block_regex(), source, return: :index) do
          assert Enum.any?(spans, fn {open, close} -> at > open and at < close end),
                 "#{conf}: an upload location at byte #{at} is outside every `location /`"
        end
      end
    end

    test "the doors' locations match exactly the router's upload paths" do
      routes = GrappaWeb.Router.__routes__()
      door_paths = for r <- routes, upload_route?(r), uniq: true, do: concrete_path(r)
      all_paths = for r <- routes, uniq: true, do: concrete_path(r)

      for conf <- @nginx_confs do
        {doors, _} = conf |> File.read!() |> nginx_ceilings(conf)

        for path <- all_paths do
          matched? = Enum.any?(doors, fn {location, _} -> nginx_location_match?(location, path) end)

          assert matched? == path in door_paths,
                 "#{conf}: #{path} matched by an upload location? #{matched?}"
        end
      end
    end
  end

  # ── Helpers ───────────────────────────────────────────────────────

  defp send_multipart(conn, method, path, body) do
    conn
    |> put_req_header("content-type", "multipart/form-data; boundary=" <> @boundary)
    |> dispatch(@endpoint, method, path, body)
  end

  defp multipart_body(file) do
    "--#{@boundary}\r\n" <>
      ~s(content-disposition: form-data; name="file"; filename="pic.png"\r\n) <>
      "content-type: image/png\r\n\r\n" <>
      file <>
      "\r\n--#{@boundary}--\r\n"
  end

  defp controller_routes,
    do: Enum.filter(GrappaWeb.Router.__routes__(), &is_atom(&1.plug_opts))

  defp upload_route?(route), do: {route.plug, route.plug_opts} in @upload_actions

  # `__routes__/0` does not carry the pipelines; `route_info/4` does, for
  # the route a concrete request resolves to. A different route answering
  # means another one shadows it, and the test says so instead of reading
  # the wrong pipelines.
  defp pipe_through(route) do
    method = route.verb |> Atom.to_string() |> String.upcase()

    case Phoenix.Router.route_info(GrappaWeb.Router, method, concrete_path(route), "localhost") do
      %{route: path, pipe_through: pipes} when path == route.path -> pipes
      other -> flunk("#{describe(route)} resolves to #{inspect(other)}")
    end
  end

  defp describe(route),
    do: "#{route.verb |> Atom.to_string() |> String.upcase()} #{route.path} (#{inspect(route.plug)}.#{route.plug_opts})"

  defp concrete_path(%{path: path}) do
    path
    |> String.split("/")
    |> Enum.map_join("/", fn
      ":" <> _ -> "placeholder"
      "*" <> _ -> "placeholder"
      segment -> segment
    end)
  end

  # Whether `action/2`, or any function of `module` it reaches through local
  # calls, mentions `Plug.Upload` — read from the compiled module's debug
  # info, where aliases are already expanded.
  defp receives_upload?(module, action) do
    defs = definitions(module)

    # A routed action that is not a `def action/2` would read as "takes no
    # file" for want of clauses, which is a guess, not an answer.
    unless Map.has_key?(defs, {action, 2}), do: flunk("#{inspect(module)}.#{action}/2 is routed but not defined")

    reaches_upload?(module, defs, {action, 2}, %{})
  end

  defp definitions(module) do
    {^module, beam, _} = :code.get_object_code(module)
    {:ok, {^module, [debug_info: {:debug_info_v1, backend, data}]}} = :beam_lib.chunks(beam, [:debug_info])
    {:ok, %{definitions: defs}} = backend.debug_info(:elixir_v1, module, data, [])

    Map.new(defs, fn {fun_arity, _, _, clauses} ->
      {fun_arity, Enum.map(clauses, fn {_, args, guards, body} -> [args, guards, body] end)}
    end)
  end

  defp reaches_upload?(module, defs, fun_arity, seen) do
    clauses = Map.get(defs, fun_arity)

    cond do
      clauses == nil or Map.has_key?(seen, fun_arity) ->
        false

      mentions_upload?(clauses) ->
        true

      true ->
        clauses
        |> local_calls(module, defs)
        |> Enum.any?(&reaches_upload?(module, defs, &1, Map.put(seen, fun_arity, true)))
    end
  end

  defp mentions_upload?(ast) do
    {_, found?} = Macro.prewalk(ast, false, fn node, acc -> {node, acc or node == Plug.Upload} end)
    found?
  end

  # The functions of `module` that `ast` calls: plain local calls, `&fun/n`
  # captures (`{fun, meta, nil}` inside the capture, no argument list), and
  # `__MODULE__.fun(...)`, which expands to a remote call on the module.
  defp local_calls(ast, module, defs) do
    {_, calls} =
      Macro.prewalk(ast, [], fn
        {:&, _, [{:/, _, [{name, _, ctx}, arity]}]} = node, acc
        when is_atom(name) and is_atom(ctx) and is_integer(arity) ->
          {node, add_call(acc, defs, {name, arity})}

        {{:., _, [^module, name]}, _, args} = node, acc when is_atom(name) and is_list(args) ->
          {node, add_call(acc, defs, {name, length(args)})}

        {name, _, args} = node, acc when is_atom(name) and is_list(args) ->
          {node, add_call(acc, defs, {name, length(args)})}

        node, acc ->
          {node, acc}
      end)

    Enum.uniq(calls)
  end

  defp add_call(acc, defs, fun_arity), do: if(Map.has_key?(defs, fun_arity), do: [fun_arity | acc], else: acc)

  defp integers(ast) do
    {_, found} = Macro.prewalk(ast, [], fn node, acc -> {node, if(is_integer(node), do: [node | acc], else: acc)} end)
    found
  end

  defp strip_nginx_comments(source), do: Regex.replace(~r/#[^\n]*/, source, "")

  defp door_block_regex, do: ~r/^\s*location\s+(=|~)\s+(\S+)\s*\{([^}]*)\}/m

  # `{[{location, mib}], [mib]}`: the size inside each `location = …` /
  # `location ~ …` block, and every other `client_max_body_size` in the
  # file. A value that is not whole megabytes (`0`, `1g`, `520M`) fails the
  # test rather than slipping past the comparison.
  defp nginx_ceilings(source, conf) do
    source = strip_nginx_comments(source)
    size = ~r/^\s*client_max_body_size\s+(\S+);/m

    doors =
      for [_, kind, pattern, body] <- Regex.scan(door_block_regex(), source),
          [_, value] <- Regex.scan(size, body),
          do: {{kind, pattern}, megabytes!(value, conf)}

    rest =
      for [_, value] <- Regex.scan(size, Regex.replace(door_block_regex(), source, "")),
          do: megabytes!(value, conf)

    {doors, rest}
  end

  defp megabytes!(value, conf) do
    case Regex.run(~r/^(\d+)m$/, value) do
      [_, mib] -> String.to_integer(mib)
      nil -> flunk("#{conf}: client_max_body_size #{value} is not in whole megabytes (`Nm`)")
    end
  end

  # Byte offsets of the `{` and the matching `}` of every `location / {`.
  defp root_location_spans(source) do
    for [{at, len}] <- Regex.scan(~r/^\s*location\s+\/\s*\{/m, source, return: :index) do
      open = at + len - 1
      {open, matching_brace(source, open + 1, 1)}
    end
  end

  defp matching_brace(_, pos, 0), do: pos - 1

  defp matching_brace(source, pos, depth) do
    case :binary.at(source, pos) do
      ?{ -> matching_brace(source, pos + 1, depth + 1)
      ?} -> matching_brace(source, pos + 1, depth - 1)
      _ -> matching_brace(source, pos + 1, depth)
    end
  end

  defp nginx_location_match?({"=", location}, path), do: location == path

  defp nginx_location_match?({"~", pattern}, path),
    do: pattern |> Regex.compile!() |> Regex.match?(path)
end
