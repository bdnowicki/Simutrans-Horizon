// Simutrans-Horizon dashboard: UI strings (English, Polish). Artistic License, see LICENSE.txt.

const STRINGS = {
	en: {
		app_title: "Simutrans dashboard",
		tab_map: "Map", tab_finances: "Finances", tab_messages: "Messages", tab_convoys: "Convoys", tab_lines: "Lines",
		tab_3d: "3D", v3d_label: "3D view of the map",
		v3d_loading: "Loading the 3D view…", v3d_chunks: "Loading terrain {0}/{1}", v3d_no_world: "No world loaded.",
		v3d_error: "3D view failed: {0}", v3d_unsupported: "This game has no 3D export (it needs a newer game version).",
		v3d_no_webgl: "The 3D view needs WebGL 2, which this browser or device does not offer (or it is turned off).",
		v3d_rotate_left: "Rotate left (Q)", v3d_rotate_right: "Rotate right (E)", v3d_zoom_in: "Zoom in (+)",
		v3d_zoom_out: "Zoom out (−)", v3d_free: "Free camera (F)", v3d_iso: "Isometric view (F)",
		v3d_hint: "Click for details (a vehicle opens its convoy, V follows it). Drag to move, wheel or pinch to zoom, Q/E to rotate, F for the free camera (right drag turns it).",
		v3d_extras: "City cars and pedestrians", v3d_following: "Following", v3d_follow_searching: "(looking for it…)",
		v3d_follow_stop: "Stop following (Esc)", follow_3d: "Follow in 3D",
		v3d_pak: "Pak 3D", v3d_pak_error: "The pak 3D is not used: {0}", v3d_authors: "Model authors",
		v3d_authors_none: "This pak 3D has no LICENSES.md.", v3d_authors_file: "File", v3d_authors_author: "Author",
		v3d_authors_license: "Licence", v3d_authors_source: "Source, notes",
		v3d_labels: "Names of cities and stations (L)", v3d_quality: "Quality and display", v3d_q_profile: "Quality",
		v3d_q_auto: "Automatic ({0})", v3d_q_low: "Low", v3d_q_medium: "Medium", v3d_q_high: "High", v3d_q_shadows: "Shadows",
		v3d_q_lod: "Detail distance", v3d_q_near: "Near", v3d_q_normal: "Normal", v3d_q_far: "Far", v3d_q_trees: "Trees",
		v3d_q_trees_profile: "Default ({0} %)", v3d_q_names: "Names of cities and stations",
		v3d_q_daynight: "Day and night by the game time", v3d_q_extras: "City cars and pedestrians",
		v3d_q_level: "Lowered automatically to keep it smooth (level {0} of 3).",
		v3d_q_restart: "Quality and trees apply when the view is built again (now).",
		loading: "Loading…", none: "none", all: "All", close: "Close", locate: "Locate", show_on_map: "Show on map",
		search: "Search", refresh: "Refresh", retry: "Retry", details: "Details", more: "More",
		// status bar
		paused: "Paused", running: "Running", fast_forward: "Fast forward",
		pause: "Pause", resume: "Resume", ff_on: "Fast forward on", ff_off: "Fast forward off",
		player: "Player", cash: "Cash", role: "Role",
		role_viewer: "viewer", role_player: "player", role_admin: "admin",
		sse_open: "Live", sse_connecting: "Connecting…", sse_closed: "Disconnected",
		game_ok: "game connected", game_down: "game not reachable", game_noworld: "no world loaded",
		missing_features: "Engine lacks: {0}", conn_details: "Connection",
		bridge: "Bridge", stream: "Event stream", game: "Game",
		updates: "Updates", updates_events: "game events (live)", updates_polling: "polling",
		logout: "Sign out", language: "Language", theme: "Theme",
		theme_auto: "Auto", theme_light: "Light", theme_dark: "Dark",
		// map
		layer_stations: "Stations", layer_factories: "Factories", layer_cities: "Cities", layer_convoys: "Convoys",
		layer_labels: "Markers", color_by: "Colour", color_owner: "Owner", color_line: "Line", color_state: "State",
		highlight_line: "Highlight line", no_highlight: "No line", map_loading: "Loading map {0}/{1}",
		map_error: "Map tiles failed: {0}", legend: "Legend", fit_map: "Whole map",
		route_straight: "Stops in schedule order (straight lines; the real route needs a newer game or bridge)",
		map_mode: "Map", tiles_failed: "{0} tiles", mode_terrain: "Terrain", mode_owner: "Owners", mode_traffic: "Traffic",
		mode_freight: "Freight", mode_passengers: "Passenger coverage", mode_mail: "Mail coverage", mode_tracks: "Tracks",
		mode_speed: "Speed limits", mode_power: "Power grid", mode_forest: "Forests", mode_level: "Building levels",
		mode_climates: "Climates",
		lg_water: "water", lg_height_high: "high", lg_low: "low", lg_high: "high", lg_few: "few", lg_many: "many",
		lg_road: "Road", lg_rail: "Rail", lg_canal: "Canal", lg_runway: "Runway", lg_power: "Power line", lg_station: "Stop",
		lg_unowned: "Ways without owner", lg_covered: "Area served by a connected stop of:",
		lg_traffic: "Convoys per month", lg_freight: "Goods per month", lg_speed: "Speed limit",
		lg_power_load: "Demand of the grid", lg_power_low: "low", lg_power_high: "over supply",
		lg_level: "Level of city buildings", lg_monthly: "Updated every game month.",
		lg_track: "Track", lg_electric: "Electrified", lg_signal: "Signal or sign", lg_trees: "Trees",
		cl_desert: "Desert", cl_tropic: "Tropical", cl_mediterran: "Mediterranean", cl_temperate: "Temperate",
		cl_tundra: "Tundra", cl_rocky: "Rocky", cl_arctic: "Arctic",
		// info card
		convoy: "Convoy", station: "Station", factory: "Factory", tile: "Tile", city: "City",
		owner: "Owner", line: "Line", state: "State", load: "Load", speed: "Speed", max_speed: "Top speed",
		vehicles: "Vehicles", next_stop: "Next stop", position: "Position",
		profit_year: "Profit this year", profit_last_month: "Profit last month",
		waiting: "Waiting", passengers: "Passengers", mail: "Mail", goods: "Goods", accepts: "Accepts",
		tiles: "Tiles", happy: "Happy", unhappy: "Unhappy", no_route_pax: "No route",
		arrived: "Arrived", departed: "Departed", convoys_arrived: "Convoys arrived",
		this_month: "This month", last_month: "Last month",
		production: "Production", inputs: "Inputs", outputs: "Outputs", suppliers: "Suppliers", consumers: "Consumers",
		storage: "Storage", in_transit: "in transit", type: "Type", ground: "Ground", objects: "Objects",
		nearest_city: "Nearest city", citizens: "Citizens", water: "water", lines_here: "Lines here",
		highlight: "Highlight", unhighlight: "Clear highlight", show_lines: "Load lines", stops: "Stops", no_line: "no line",
		load_failed: "Could not load: {0}", unknown: "unknown",
		// finances
		net_wealth: "Net wealth", revenue: "Revenue", running_costs: "Running costs",
		maintenance: "Infrastructure maintenance", operating_profit: "Operating profit", profit: "Profit",
		construction: "Construction", new_vehicles: "New vehicles",
		transported_passengers: "Passengers transported", transported_mail: "Mail transported",
		transported_goods: "Goods transported", lines: "Lines", convoys: "Convoys", stations: "Stations",
		cash_chart: "Cash during this session", chart_note: "Sampled live from the game; the monthly history needs a newer engine.",
		no_samples: "No samples yet: the chart fills while the game runs.", players_title: "Players", active: "active", game_date: "Game date",
		month_progress: "Month progress", world: "World", counts: "Objects",
		// messages
		messages: "Messages", type_filter: "Type", no_messages: "No messages.", only_with_pos: "With position only",
		this_month_rel: "this month",
		// convoys
		name: "Name", profit_short: "Profit", profit_lm_short: "Last month", filter_owner: "Owner", filter_line: "Line",
		filter_state: "State", st_problems: "Any problem", st_no_route: "No route", st_stuck: "Stuck",
		st_loss: "Loss-making", st_loading: "Loading", st_driving: "Driving", st_depot: "In depot",
		count_of: "{0} of {1}", full_data_age: "details {0} s old", full_data_loading: "loading details…",
		loss_needs_details: "Loss filter: waiting for convoy details", rows_none: "No matching rows.",
		id: "ID",
		// lines
		transport: "Transport", transported: "Transported", capacity: "Capacity", utilisation: "Use",
		line_profit_month: "Profit (month)", line_profit_last: "Profit (last month)",
		// detail panels
		back: "Back", line_details: "Line details", locate_on_map: "Locate on map", schedule: "Schedule",
		route: "Route", route_driven: "driven by convoys", route_unseen: "not seen yet (straight)",
		route_complete: "The whole route is known.", route_partial: "Route: {0} of {1} legs seen so far; the rest is drawn straight. More legs appear as the convoys drive.",
		capacity_load: "Capacity and load", n_convoys: "{0} convoys", n_stops: "{0} stops", n_tiles: "{0} tiles",
		withdraw: "withdrawing", history_12: "Last 12 months", depot: "Depot", waypoint: "Waypoint",
		min_load: "min. load {0} %", departures_month: "{0} departures/month", max_wait: "max. waiting time",
		needs_engine: "Details need a newer game version; showing what it offers.",
		grp_money: "Money", grp_transport: "Transport", grp_handling: "Goods", col_operation: "Operation",
		col_toll: "Toll", col_free_capacity: "Free capacity", col_distance: "Distance", col_max_speed: "Top speed",
		col_walked: "Walked", no_history: "No history.", chart_choice: "Chart", show_chart: "Chart",
		show_table: "Table", month: "Month", year: "Year", so_far: "so far",
		vehicle: "Vehicle", age: "Age", value: "Value", retired: "out of production",
		retired_long: "This vehicle is no longer built.", age_ym: "{0} y {1} m", age_m: "{0} m",
		freight: "Freight", empty_convoy: "Nothing loaded.", amount: "Amount", destination: "To", via: "Via",
		next_stop_short: "next", current_leg: "Current leg", leg_progress: "Driven", leg_on_map: "Drawn in blue on the map.",
		power: "Power", weight: "Weight", empty: "empty", running_cost_km: "Running cost per km",
		odometer: "Odometer", home_depot: "Home depot", no_load: "no loading", length_tiles: "{0} tiles long",
		separate_storage: "separate storage per kind", shared_storage: "one storage for all kinds",
		waiting_goods: "Waiting by goods", waiting_next: "Waiting by next stop", waiting_other: "for stops no longer connected",
		lineless_convoys: "Convoys without line", departures: "Departures", arrivals: "Arrivals",
		board_empty: "Nothing expected.", time: "Time", to: "To", from: "From",
		// finances (history of the game)
		period: "Period", period_month: "Months", period_year: "Years", pp: "pp", vs: "vs {0}",
		end_of: "end of {0}", profit_gross: "Gross profit", margin: "Margin", assets: "Vehicle value",
		delivered: "Delivered", this_month_so_far: "This month so far: {0}", this_year_so_far: "This year so far: {0}",
		kpi_note_month: "{0} (the last full month), change against {1}.", kpi_note_year: "{0} (the last full year), change against {1}.",
		maintenance_now: "Infrastructure maintenance now: {0} per month", overdrawn: "overdrawn for {0} months",
		chart_revenue_costs: "Revenue and costs", chart_profit: "Profit", chart_wealth: "Cash and net wealth",
		chart_transported: "Transported (passengers, mail, goods)",
		chart_last_month: "Complete months; cash and net wealth up to today.", chart_last_year: "Complete years; cash and net wealth up to today.",
		chart_complete: "Complete months (the running month is in the table).",
		tt_all: "All", tt_road: "Road", tt_rail: "Rail", tt_ship: "Ship", tt_monorail: "Monorail", tt_maglev: "Maglev",
		tt_tram: "Tram", tt_narrowgauge: "Narrow gauge", tt_air: "Air", tt_other: "Other", tt_powerline: "Power lines",
		// world tab, cities, factories
		tab_world: "World", world_views: "World views", world_overview: "Overview", world_cities: "Cities",
		world_factories: "Factories", growth: "Growth", growth_month: "Growth (month)", buildings: "Buildings",
		pax_share: "Passengers carried", mail_share: "Mail carried", goods_share: "Shops supplied",
		pax_share_tip: "Share of the passengers generated last month that travelled",
		mail_share_tip: "Share of the mail generated last month that was carried",
		goods_share_tip: "How often the shops had goods when checked last month",
		city_area: "{0} × {1} tiles", growth_rate: "Growth rate", growth_this_month: "this month: {0}",
		unemployed: "Unemployed", homeless: "Homeless", free_jobs: "{0} free jobs", free_homes: "{0} free homes",
		growth_stopped: "growth stopped", col_generated: "Generated", col_transported: "Transported",
		share: "Share", goods_supplied: "Shops had goods", goods_needed: "Shops checked", citycars: "City cars",
		grp_citizens: "Citizens", grp_growth: "Growth", grp_buildings: "Buildings", grp_pax: "Passengers",
		grp_mail: "Mail", grp_goods: "Goods in shops", grp_cars: "City cars",
		legend_hint: "Click a legend entry to hide or show that line.", history_years: "Last 12 years",
		chart_complete_year: "Complete years (the running year is in the table).", city_limits: "The city limits are drawn on the map.",
		fs_good: "Good", fs_medium: "Medium", fs_bad: "Bad", fs_inactive: "Inactive", fs_nothing: "No production",
		fs_unknown: "Unknown", status: "Status", max_production: "Max. production", per_day: "{0}/day",
		per_minute: "{0} units/minute", productivity: "Productivity", boosts: "Boosts", electricity: "Electricity",
		power_offer: "Power offered", power_use: "Power used / needed", power_last: "last month {0} MW",
		in_transit_n: "{0} on the way",
		transformer: "Transformer", connected: "connected", not_connected: "not connected",
		fields: "Fields", fields_min: "{0} (at least {1})", received: "Received", consumed: "Consumed",
		produced: "Produced", delivered_n: "Delivered", max_transit: "at most {0} in transit", factor: "{0} % per unit",
		link_active: "delivered recently", link_inactive: "no recent deliveries", halts_serving: "Stops serving it",
		connected_cities: "Cities sending workers and mail", commuters_mail: "workers {0} · mail {1}",
		not_served: "No stop serves this factory.", grp_production: "Production", grp_power: "Power",
		grp_boost: "Boosts", col_departed: "Departed", col_arrived: "Arrived", goods_history: "Goods history",
		grp_storage: "Storage", grp_flow: "Flow", col_in_transit: "In transit", links_on_map: "Its supply links are emphasised on the map.",
		show_links: "Show links", factory_gone: "No factory at this position (any more).",
		col_status: "Status", col_productivity: "Productivity", col_input: "Input stock", col_output: "Output stock",
		col_served: "Served", yes: "yes", no: "no", filter_type: "Type", filter_status: "Status",
		status_loading: "status loading…", status_age: "status {0} s old", status_needs_engine: "Status needs a newer game.",
		towns: "Towns", factories_n: "Factories", passengers_generated: "Passengers generated", mail_generated: "Mail generated",
		chart_citizens: "Citizens", chart_growth: "Growth", chart_ratios: "Share transported (%)",
		chart_generated: "Passengers and mail generated", chart_goods: "Goods transported", chart_convoys: "Convoys",
		chart_citycars: "City cars", world_needs_engine: "World statistics need a newer game version.",
		goods_list: "Goods and their colours", col_unit: "Unit", col_category: "Category", col_speed_bonus: "Speed bonus",
		used_only: "Only goods used in this world", value_note: "Value: revenue per unit for 100 tiles at average speed.",
		kpi_note_world_month: "{0} (the last full month), change against {1}.", kpi_note_world_year: "{0} (the last full year), change against {1}.",
		now: "now",
		layer_supply: "Supply chains", supply_active: "solid: goods delivered recently",
		supply_inactive: "dashed: no recent deliveries", supply_none: "No supply links.",
		supply_needs_engine: "Supply chains need a newer game version.", supply_focus: "Links of the open factory are emphasised.",
		// errors
		action_failed: "{0} failed: {1}", http_error: "HTTP {0}", network_error: "network error",
		rate_limited: "too many requests, try again", game_unreachable: "the game is not reachable",
	},
	pl: {
		app_title: "Panel Simutrans",
		tab_map: "Mapa", tab_finances: "Finanse", tab_messages: "Wiadomości", tab_convoys: "Pojazdy", tab_lines: "Linie",
		tab_3d: "3D", v3d_label: "Widok 3D mapy",
		v3d_loading: "Wczytywanie widoku 3D…", v3d_chunks: "Wczytywanie terenu {0}/{1}", v3d_no_world: "Nie wczytano świata.",
		v3d_error: "Błąd widoku 3D: {0}", v3d_unsupported: "Ta gra nie eksportuje widoku 3D (potrzebna nowsza wersja gry).",
		v3d_no_webgl: "Widok 3D wymaga WebGL 2, którego ta przeglądarka lub to urządzenie nie oferuje (albo jest wyłączony).",
		v3d_rotate_left: "Obróć w lewo (Q)", v3d_rotate_right: "Obróć w prawo (E)", v3d_zoom_in: "Przybliż (+)",
		v3d_zoom_out: "Oddal (−)", v3d_free: "Wolna kamera (F)", v3d_iso: "Widok izometryczny (F)",
		v3d_hint: "Kliknij, aby zobaczyć szczegóły (pojazd otwiera swój konwój, V go śledzi). Przeciągnij, aby przesunąć; kółko lub szczypnięcie przybliża, Q/E obraca, F włącza wolną kamerę (obrót prawym przyciskiem).",
		v3d_extras: "Samochody miejskie i piesi", v3d_following: "Śledzenie", v3d_follow_searching: "(szukam…)",
		v3d_follow_stop: "Przestań śledzić (Esc)", follow_3d: "Śledź w 3D",
		v3d_pak: "Pak 3D", v3d_pak_error: "Pak 3D nie jest używany: {0}", v3d_authors: "Autorzy modeli",
		v3d_authors_none: "Ten pak 3D nie ma pliku LICENSES.md.", v3d_authors_file: "Plik", v3d_authors_author: "Autor",
		v3d_authors_license: "Licencja", v3d_authors_source: "Źródło, uwagi",
		v3d_labels: "Nazwy miast i stacji (L)", v3d_quality: "Jakość i wyświetlanie", v3d_q_profile: "Jakość",
		v3d_q_auto: "Automatyczna ({0})", v3d_q_low: "Niska", v3d_q_medium: "Średnia", v3d_q_high: "Wysoka", v3d_q_shadows: "Cienie",
		v3d_q_lod: "Zasięg szczegółów", v3d_q_near: "Bliski", v3d_q_normal: "Zwykły", v3d_q_far: "Daleki", v3d_q_trees: "Drzewa",
		v3d_q_trees_profile: "Domyślnie ({0} %)", v3d_q_names: "Nazwy miast i stacji",
		v3d_q_daynight: "Dzień i noc według czasu gry", v3d_q_extras: "Samochody miejskie i piesi",
		v3d_q_level: "Obniżona automatycznie dla płynności (poziom {0} z 3).",
		v3d_q_restart: "Jakość i drzewa działają po ponownym zbudowaniu widoku (od razu).",
		loading: "Wczytywanie…", none: "brak", all: "Wszystkie", close: "Zamknij", locate: "Pokaż", show_on_map: "Pokaż na mapie",
		search: "Szukaj", refresh: "Odśwież", retry: "Ponów", details: "Szczegóły", more: "Więcej",
		paused: "Pauza", running: "Gra trwa", fast_forward: "Przyspieszenie",
		pause: "Pauza", resume: "Wznów", ff_on: "Włącz przyspieszenie", ff_off: "Wyłącz przyspieszenie",
		player: "Gracz", cash: "Gotówka", role: "Rola",
		role_viewer: "widz", role_player: "gracz", role_admin: "administrator",
		sse_open: "Na żywo", sse_connecting: "Łączenie…", sse_closed: "Rozłączono",
		game_ok: "gra połączona", game_down: "gra nieosiągalna", game_noworld: "brak wczytanego świata",
		missing_features: "Silnikowi brakuje: {0}", conn_details: "Połączenie",
		bridge: "Mostek", stream: "Strumień zdarzeń", game: "Gra",
		updates: "Aktualizacje", updates_events: "zdarzenia gry (na żywo)", updates_polling: "odpytywanie",
		logout: "Wyloguj", language: "Język", theme: "Motyw",
		theme_auto: "Automatyczny", theme_light: "Jasny", theme_dark: "Ciemny",
		layer_stations: "Stacje", layer_factories: "Fabryki", layer_cities: "Miasta", layer_convoys: "Pojazdy",
		layer_labels: "Znaczniki", color_by: "Kolor", color_owner: "Właściciel", color_line: "Linia", color_state: "Stan",
		highlight_line: "Wyróżnij linię", no_highlight: "Bez linii", map_loading: "Wczytywanie mapy {0}/{1}",
		map_error: "Błąd fragmentów mapy: {0}", legend: "Legenda", fit_map: "Cała mapa",
		route_straight: "Przystanki w kolejności rozkładu (linie proste; prawdziwa trasa wymaga nowszej gry lub mostka)",
		map_mode: "Mapa", tiles_failed: "{0} fragm.", mode_terrain: "Teren", mode_owner: "Właściciele", mode_traffic: "Ruch",
		mode_freight: "Towary", mode_passengers: "Zasięg pasażerski", mode_mail: "Zasięg poczty", mode_tracks: "Tory",
		mode_speed: "Ograniczenia prędkości", mode_power: "Sieć energetyczna", mode_forest: "Lasy",
		mode_level: "Poziom zabudowy", mode_climates: "Strefy klimatyczne",
		lg_water: "woda", lg_height_high: "wysoko", lg_low: "niski", lg_high: "wysoki", lg_few: "mało", lg_many: "dużo",
		lg_road: "Droga", lg_rail: "Tory", lg_canal: "Kanał", lg_runway: "Pas startowy", lg_power: "Linia energetyczna",
		lg_station: "Przystanek", lg_unowned: "Drogi bez właściciela", lg_covered: "Obszar obsługiwany przez połączone przystanki:",
		lg_traffic: "Pojazdy na miesiąc", lg_freight: "Towary na miesiąc", lg_speed: "Ograniczenie prędkości",
		lg_power_load: "Zapotrzebowanie sieci", lg_power_low: "niskie", lg_power_high: "ponad podaż",
		lg_level: "Poziom budynków miejskich", lg_monthly: "Odświeżane co miesiąc gry.",
		lg_track: "Tor", lg_electric: "Zelektryfikowany", lg_signal: "Sygnał lub znak", lg_trees: "Drzewa",
		cl_desert: "Pustynia", cl_tropic: "Tropikalny", cl_mediterran: "Śródziemnomorski", cl_temperate: "Umiarkowany",
		cl_tundra: "Tundra", cl_rocky: "Skalisty", cl_arctic: "Arktyczny",
		convoy: "Pojazd", station: "Stacja", factory: "Fabryka", tile: "Pole", city: "Miasto",
		owner: "Właściciel", line: "Linia", state: "Stan", load: "Załadunek", speed: "Prędkość", max_speed: "Prędkość maks.",
		vehicles: "Wagony", next_stop: "Następny przystanek", position: "Pozycja",
		profit_year: "Zysk w tym roku", profit_last_month: "Zysk w zeszłym miesiącu",
		waiting: "Oczekujące", passengers: "Pasażerowie", mail: "Poczta", goods: "Towary", accepts: "Przyjmuje",
		tiles: "Pola", happy: "Zadowoleni", unhappy: "Niezadowoleni", no_route_pax: "Bez połączenia",
		arrived: "Przybyło", departed: "Odjechało", convoys_arrived: "Przyjazdy pojazdów",
		this_month: "Ten miesiąc", last_month: "Zeszły miesiąc",
		production: "Produkcja", inputs: "Surowce", outputs: "Produkty", suppliers: "Dostawcy", consumers: "Odbiorcy",
		storage: "Magazyn", in_transit: "w drodze", type: "Typ", ground: "Podłoże", objects: "Obiekty",
		nearest_city: "Najbliższe miasto", citizens: "Mieszkańcy", water: "woda", lines_here: "Linie na stacji",
		highlight: "Wyróżnij", unhighlight: "Usuń wyróżnienie", show_lines: "Wczytaj linie", stops: "Przystanki", no_line: "bez linii",
		load_failed: "Nie udało się wczytać: {0}", unknown: "nieznany",
		net_wealth: "Wartość całkowita", revenue: "Przychody", running_costs: "Koszty eksploatacji",
		maintenance: "Utrzymanie infrastruktury", operating_profit: "Zysk operacyjny", profit: "Zysk",
		construction: "Budowa", new_vehicles: "Nowe pojazdy",
		transported_passengers: "Przewiezieni pasażerowie", transported_mail: "Przewieziona poczta",
		transported_goods: "Przewiezione towary", lines: "Linie", convoys: "Pojazdy", stations: "Stacje",
		cash_chart: "Gotówka w tej sesji", chart_note: "Próbki pobierane na żywo z gry; historia miesięczna wymaga nowszego silnika.",
		no_samples: "Brak próbek: wykres zapełnia się, gdy gra trwa.", players_title: "Gracze", active: "aktywny", game_date: "Data w grze",
		month_progress: "Postęp miesiąca", world: "Świat", counts: "Obiekty",
		messages: "Wiadomości", type_filter: "Rodzaj", no_messages: "Brak wiadomości.", only_with_pos: "Tylko z pozycją",
		this_month_rel: "w tym miesiącu",
		name: "Nazwa", profit_short: "Zysk", profit_lm_short: "Zeszły mies.", filter_owner: "Właściciel", filter_line: "Linia",
		filter_state: "Stan", st_problems: "Dowolny problem", st_no_route: "Brak trasy", st_stuck: "Zablokowane",
		st_loss: "Przynoszące straty", st_loading: "Załadunek", st_driving: "W drodze", st_depot: "W zajezdni",
		count_of: "{0} z {1}", full_data_age: "szczegóły sprzed {0} s", full_data_loading: "wczytywanie szczegółów…",
		loss_needs_details: "Filtr strat: czekam na szczegóły pojazdów", rows_none: "Brak pasujących wierszy.",
		id: "ID",
		transport: "Transport", transported: "Przewiezione", capacity: "Pojemność", utilisation: "Wykorzystanie",
		line_profit_month: "Zysk (miesiąc)", line_profit_last: "Zysk (zeszły mies.)",
		back: "Wstecz", line_details: "Szczegóły linii", locate_on_map: "Pokaż na mapie", schedule: "Rozkład",
		route: "Trasa", route_driven: "przejechana przez pojazdy", route_unseen: "jeszcze nie widziana (linia prosta)",
		route_complete: "Cała trasa jest znana.", route_partial: "Trasa: znane {0} z {1} odcinków; reszta jest rysowana prosto. Kolejne odcinki pojawiają się, gdy pojazdy jeżdżą.",
		capacity_load: "Pojemność i załadunek", n_convoys: "pojazdy: {0}", n_stops: "przystanki: {0}", n_tiles: "pola: {0}",
		withdraw: "wycofywana", history_12: "Ostatnie 12 miesięcy", depot: "Zajezdnia", waypoint: "Punkt trasy",
		min_load: "min. załadunek {0} %", departures_month: "{0} odjazdów/mies.", max_wait: "maks. czas oczekiwania",
		needs_engine: "Szczegóły wymagają nowszej wersji gry; pokazuję to, co udostępnia.",
		grp_money: "Pieniądze", grp_transport: "Przewozy", grp_handling: "Towary", col_operation: "Eksploatacja",
		col_toll: "Opłaty", col_free_capacity: "Wolne miejsca", col_distance: "Dystans", col_max_speed: "Prędkość maks.",
		col_walked: "Pieszo", no_history: "Brak historii.", chart_choice: "Wykres", show_chart: "Wykres",
		show_table: "Tabela", month: "Miesiąc", year: "Rok", so_far: "dotąd",
		vehicle: "Pojazd", age: "Wiek", value: "Wartość", retired: "wycofany z produkcji",
		retired_long: "Ten pojazd nie jest już produkowany.", age_ym: "{0} l. {1} mies.", age_m: "{0} mies.",
		freight: "Ładunek", empty_convoy: "Nic nie załadowano.", amount: "Ilość", destination: "Do", via: "Przez",
		next_stop_short: "następny", current_leg: "Bieżący odcinek", leg_progress: "Przejechano", leg_on_map: "Narysowany na niebiesko na mapie.",
		power: "Moc", weight: "Masa", empty: "pusty", running_cost_km: "Koszt eksploatacji na km",
		odometer: "Przebieg", home_depot: "Zajezdnia macierzysta", no_load: "bez załadunku", length_tiles: "długość {0} pól",
		separate_storage: "osobne magazyny dla rodzajów", shared_storage: "jeden magazyn dla wszystkich rodzajów",
		waiting_goods: "Oczekujące według towarów", waiting_next: "Oczekujące według następnego przystanku", waiting_other: "do przystanków już niepołączonych",
		lineless_convoys: "Pojazdy bez linii", departures: "Odjazdy", arrivals: "Przyjazdy",
		board_empty: "Nikt nie jest oczekiwany.", time: "Czas", to: "Do", from: "Z",
		period: "Okres", period_month: "Miesiące", period_year: "Lata", pp: "pp", vs: "wobec {0}",
		end_of: "koniec: {0}", profit_gross: "Zysk brutto", margin: "Marża", assets: "Wartość pojazdów",
		delivered: "Dostarczone", this_month_so_far: "W tym miesiącu dotąd: {0}", this_year_so_far: "W tym roku dotąd: {0}",
		kpi_note_month: "{0} (ostatni pełny miesiąc), zmiana wobec: {1}.", kpi_note_year: "{0} (ostatni pełny rok), zmiana wobec: {1}.",
		maintenance_now: "Utrzymanie infrastruktury teraz: {0} miesięcznie", overdrawn: "debet od {0} mies.",
		chart_revenue_costs: "Przychody i koszty", chart_profit: "Zysk", chart_wealth: "Gotówka i wartość całkowita",
		chart_transported: "Przewiezione (pasażerowie, poczta, towary)",
		chart_last_month: "Pełne miesiące; gotówka i wartość całkowita do dziś.", chart_last_year: "Pełne lata; gotówka i wartość całkowita do dziś.",
		chart_complete: "Pełne miesiące (bieżący miesiąc jest w tabeli).",
		tt_all: "Wszystkie", tt_road: "Drogowy", tt_rail: "Kolejowy", tt_ship: "Wodny", tt_monorail: "Kolej jednoszynowa",
		tt_maglev: "Maglev", tt_tram: "Tramwajowy", tt_narrowgauge: "Wąskotorowy", tt_air: "Lotniczy", tt_other: "Inne",
		tt_powerline: "Linie energetyczne",
		tab_world: "Świat", world_views: "Widoki świata", world_overview: "Przegląd", world_cities: "Miasta",
		world_factories: "Fabryki", growth: "Wzrost", growth_month: "Wzrost (miesiąc)", buildings: "Budynki",
		pax_share: "Przewiezieni pasażerowie", mail_share: "Przewieziona poczta", goods_share: "Zaopatrzenie sklepów",
		pax_share_tip: "Udział pasażerów z zeszłego miesiąca, którzy odbyli podróż",
		mail_share_tip: "Udział poczty z zeszłego miesiąca, która została przewieziona",
		goods_share_tip: "Jak często sklepy miały towary przy sprawdzeniu w zeszłym miesiącu",
		city_area: "{0} × {1} pól", growth_rate: "Tempo wzrostu", growth_this_month: "w tym miesiącu: {0}",
		unemployed: "Bezrobotni", homeless: "Bezdomni", free_jobs: "wolne miejsca pracy: {0}", free_homes: "wolne mieszkania: {0}",
		growth_stopped: "wzrost wstrzymany", col_generated: "Wygenerowano", col_transported: "Przewieziono",
		share: "Udział", goods_supplied: "Sklepy miały towary", goods_needed: "Sprawdzenia sklepów", citycars: "Samochody mieszkańców",
		grp_citizens: "Mieszkańcy", grp_growth: "Wzrost", grp_buildings: "Budynki", grp_pax: "Pasażerowie",
		grp_mail: "Poczta", grp_goods: "Towary w sklepach", grp_cars: "Samochody mieszkańców",
		legend_hint: "Kliknij pozycję legendy, aby ukryć lub pokazać tę linię.", history_years: "Ostatnie 12 lat",
		chart_complete_year: "Pełne lata (bieżący rok jest w tabeli).", city_limits: "Granice miasta są zaznaczone na mapie.",
		fs_good: "Dobry", fs_medium: "Średni", fs_bad: "Zły", fs_inactive: "Nieaktywna", fs_nothing: "Bez produkcji",
		fs_unknown: "Nieznany", status: "Stan", max_production: "Maks. produkcja", per_day: "{0}/dzień",
		per_minute: "{0} jedn./min", productivity: "Wydajność", boosts: "Premie", electricity: "Prąd",
		power_offer: "Oferowana moc", power_use: "Moc pobierana / potrzebna", power_last: "w zeszłym miesiącu {0} MW",
		in_transit_n: "w drodze: {0}",
		transformer: "Transformator", connected: "podłączony", not_connected: "niepodłączony",
		fields: "Pola uprawne", fields_min: "{0} (co najmniej {1})", received: "Otrzymano", consumed: "Zużyto",
		produced: "Wyprodukowano", delivered_n: "Dostarczono", max_transit: "maks. {0} w drodze", factor: "{0} % na jednostkę",
		link_active: "ostatnio były dostawy", link_inactive: "brak ostatnich dostaw", halts_serving: "Obsługujące przystanki",
		connected_cities: "Miasta wysyłające pracowników i pocztę", commuters_mail: "pracownicy {0} · poczta {1}",
		not_served: "Żaden przystanek nie obsługuje tej fabryki.", grp_production: "Produkcja", grp_power: "Moc",
		grp_boost: "Premie", col_departed: "Odjechało", col_arrived: "Przybyło", goods_history: "Historia towarów",
		grp_storage: "Magazyn", grp_flow: "Przepływ", col_in_transit: "W drodze", links_on_map: "Jej powiązania dostaw są wyróżnione na mapie.",
		show_links: "Pokaż powiązania", factory_gone: "W tym miejscu nie ma (już) fabryki.",
		col_status: "Stan", col_productivity: "Wydajność", col_input: "Zapas surowców", col_output: "Zapas produktów",
		col_served: "Obsługiwana", yes: "tak", no: "nie", filter_type: "Typ", filter_status: "Stan",
		status_loading: "wczytywanie stanu…", status_age: "stan sprzed {0} s", status_needs_engine: "Stan wymaga nowszej gry.",
		towns: "Miasta", factories_n: "Fabryki", passengers_generated: "Wygenerowani pasażerowie", mail_generated: "Wygenerowana poczta",
		chart_citizens: "Mieszkańcy", chart_growth: "Wzrost", chart_ratios: "Udział przewiezionych (%)",
		chart_generated: "Wygenerowani pasażerowie i poczta", chart_goods: "Przewiezione towary", chart_convoys: "Pojazdy",
		chart_citycars: "Samochody mieszkańców", world_needs_engine: "Statystyki świata wymagają nowszej wersji gry.",
		goods_list: "Towary i ich kolory", col_unit: "Jednostka", col_category: "Kategoria", col_speed_bonus: "Premia za szybkość",
		used_only: "Tylko towary używane w tym świecie", value_note: "Wartość: przychód za jednostkę na 100 pól przy średniej prędkości.",
		kpi_note_world_month: "{0} (ostatni pełny miesiąc), zmiana wobec: {1}.", kpi_note_world_year: "{0} (ostatni pełny rok), zmiana wobec: {1}.",
		now: "teraz",
		layer_supply: "Łańcuchy dostaw", supply_active: "linia ciągła: ostatnio były dostawy",
		supply_inactive: "linia przerywana: brak ostatnich dostaw", supply_none: "Brak powiązań dostaw.",
		supply_needs_engine: "Łańcuchy dostaw wymagają nowszej wersji gry.", supply_focus: "Powiązania otwartej fabryki są wyróżnione.",
		action_failed: "{0} – błąd: {1}", http_error: "HTTP {0}", network_error: "błąd sieci",
		rate_limited: "za dużo żądań, spróbuj ponownie", game_unreachable: "gra jest nieosiągalna",
	},
};

const STATES = {
	en: {
		in_depot: "In depot", edit_schedule: "Editing schedule", routing: "Routing", no_route: "No route",
		driving: "Driving", loading: "Loading", waiting_for_clearance: "Waiting for clearance",
		waiting_for_clearance_one_month: "Stuck (1 month)", waiting_for_clearance_two_months: "Stuck (2+ months)",
		can_start: "Ready to leave", can_start_one_month: "Cannot leave (1 month)",
		can_start_two_months: "Cannot leave (2+ months)", self_destruct: "Being removed",
		leaving_depot: "Leaving depot", entering_depot: "Entering depot",
	},
	pl: {
		in_depot: "W zajezdni", edit_schedule: "Edycja rozkładu", routing: "Wyznaczanie trasy", no_route: "Brak trasy",
		driving: "W drodze", loading: "Załadunek", waiting_for_clearance: "Czeka na wolną drogę",
		waiting_for_clearance_one_month: "Zablokowany (1 mies.)", waiting_for_clearance_two_months: "Zablokowany (2+ mies.)",
		can_start: "Gotowy do odjazdu", can_start_one_month: "Nie może odjechać (1 mies.)",
		can_start_two_months: "Nie może odjechać (2+ mies.)", self_destruct: "Usuwany",
		leaving_depot: "Wyjeżdża z zajezdni", entering_depot: "Wjeżdża do zajezdni",
	},
};

const MSG_TYPES = {
	en: {
		general: "General", ai: "AI", city: "Cities", problems: "Problems", industry: "Industry", chat: "Chat",
		new_vehicle: "New vehicles", full: "Full stations", warnings: "Warnings", traffic_jams: "Traffic jams",
		scenario: "Scenario", chat_common: "Chat (all)", chat_company: "Chat (company)", chat_private: "Chat (private)",
	},
	pl: {
		general: "Ogólne", ai: "SI", city: "Miasta", problems: "Problemy", industry: "Przemysł", chat: "Czat",
		new_vehicle: "Nowe pojazdy", full: "Pełne stacje", warnings: "Ostrzeżenia", traffic_jams: "Korki",
		scenario: "Scenariusz", chat_common: "Czat (wszyscy)", chat_company: "Czat (firma)", chat_private: "Czat (prywatny)",
	},
};

const MONTHS = {
	en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
	pl: ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"],
};

export const LANGS = [["en", "English"], ["pl", "Polski"]];

function initialLang() {
	try {
		const saved = localStorage.getItem("sdash.lang");
		if (saved && STRINGS[saved]) {
			return saved;
		}
	} catch (e) { /* storage blocked */ }
	const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
	return nav.toLowerCase().startsWith("pl") ? "pl" : "en";
}

let lang = initialLang();

export function getLang() {
	return lang;
}

export function setLang(code) {
	if (!STRINGS[code]) {
		return;
	}
	lang = code;
	document.documentElement.lang = code;
	try {
		localStorage.setItem("sdash.lang", code);
	} catch (e) { /* storage blocked */ }
}

document.documentElement.lang = lang;

/** Translated string; {0}, {1}… are replaced by the arguments. */
export function t(key, ...args) {
	let s = STRINGS[lang][key];
	if (s === undefined) {
		s = STRINGS.en[key] !== undefined ? STRINGS.en[key] : key;
	}
	if (args.length) {
		s = s.replace(/\{(\d)\}/g, (m, i) => (args[i] === undefined ? "" : String(args[i])));
	}
	return s;
}

export function stateName(name) {
	return STATES[lang][name] || STATES.en[name] || String(name || "?");
}

export function msgTypeName(name) {
	return MSG_TYPES[lang][name] || MSG_TYPES.en[name] || String(name || "?");
}

export const MESSAGE_TYPE_KEYS = Object.keys(MSG_TYPES.en);

export function monthName(m) {
	return MONTHS[lang][(m - 1 + 12) % 12];
}

/** "3 months ago" / "3 miesiące temu" etc. for a difference in game months (>= 0). */
export function monthsAgo(n) {
	if (n <= 0) {
		return t("this_month_rel");
	}
	if (lang === "pl") {
		if (n >= 12) {
			const y = Math.floor(n / 12);
			return y === 1 ? "rok temu" : `${y} ${plural(y, "lata", "lat")} temu`;
		}
		return n === 1 ? "miesiąc temu" : `${n} ${plural(n, "miesiące", "miesięcy")} temu`;
	}
	if (n >= 12) {
		const y = Math.floor(n / 12);
		return y === 1 ? "a year ago" : `${y} years ago`;
	}
	return n === 1 ? "a month ago" : `${n} months ago`;
}

// Polish plural for n >= 2: 2-4 (not 12-14) -> few, else many
function plural(n, few, many) {
	const d = n % 10, h = n % 100;
	return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

export function locale() {
	return lang === "pl" ? "pl-PL" : "en-US";
}
