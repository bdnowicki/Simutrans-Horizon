/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 *
 * Simutrans-Horizon, 2026-11: new file, the -remote_control automation interface, with the agent mode
 * (-remote_control_agent) for the AI team of the dashboard
 */

// must be included before all simutrans stuff (winsock)
#include "network.h"

#include "remote_control.h"

#include "../simdebug.h"
#include "../simevent.h"
#include "../simhalt.h"
#include "../simintr.h"
#include "../simware.h"
#include "../simmesg.h"
#include "../world/simworld.h"
#include "../world/simcity.h"
#include "../world/simplan.h"
#include "../ground/grund.h"
#include "../obj/simobj.h"
#include "../obj/zeiger.h"
#include "../player/simplay.h"
#include "../player/finance.h"
#include "../display/simgraph.h"
#include "../display/viewport.h"
#include "../dataobj/environment.h"
#include "../dataobj/scenario.h"
#include "../dataobj/translator.h"
#include "../gui/simwin.h"
#include "../gui/gui_frame.h"
#include "../gui/gui_theme.h"
#include "../gui/components/gui_container.h"
#include "../gui/components/gui_button.h"
#include "../gui/components/gui_label.h"
#include "../gui/components/gui_textinput.h"
#include "../gui/components/gui_scrollpane.h"
#include "../gui/components/gui_scrolled_list.h"
#include "../gui/components/gui_tab_panel.h"
#include "../gui/tool_selector.h"
#include "../gui/minimap.h"
#include "../io/raw_image.h"
#include "../tool/simmenu.h"
#include "../simconvoi.h"
#include "../simfab.h"
#include "../simline.h"
#include "../builder/brueckenbauer.h"
#include "../builder/goods_manager.h"
#include "../builder/hausbauer.h"
#include "../builder/tree_builder.h"
#include "../builder/tunnelbauer.h"
#include "../builder/vehikelbauer.h"
#include "../builder/wegbauer.h"
#include "../dataobj/ribi.h"
#include "../dataobj/route.h"
#include "../dataobj/schedule.h"
#include "../descriptor/bridge_desc.h"
#include "../descriptor/building_desc.h"
#include "../descriptor/citycar_desc.h"
#include "../descriptor/factory_desc.h"
#include "../descriptor/goods_desc.h"
#include "../descriptor/pedestrian_desc.h"
#include "../descriptor/roadsign_desc.h"
#include "../descriptor/tree_desc.h"
#include "../descriptor/tunnel_desc.h"
#include "../descriptor/vehicle_desc.h"
#include "../descriptor/way_desc.h"
#include "../descriptor/way_obj_desc.h"
#include "../obj/baum.h"
#include "../obj/bruecke.h"
#include "../obj/depot.h"
#include "../obj/field.h"
#include "../obj/gebaeude.h"
#include "../obj/label.h"
#include "../obj/leitung2.h"
#include "../obj/pillar.h"
#include "../obj/roadsign.h"
#include "../obj/tunnel.h"
#include "../obj/wayobj.h"
#include "../obj/way/weg.h"
#include "../vehicle/air_vehicle.h"
#include "../vehicle/pedestrian.h"
#include "../vehicle/simroadtraffic.h"
#include "../vehicle/simtestdriver.h"
#include "../vehicle/vehicle.h"
#include "../script/script.h"
#include "../script/script_loader.h"
#include "../sys/simsys.h"
#include "../utils/cbuffer.h"
#include "../utils/simrandom.h"
#include "../utils/simstring.h"
#include "../tpl/slist_tpl.h"
#include "../tpl/vector_tpl.h"

#include "../../squirrel/squirrel.h"
#include "../../squirrel/sq_extensions.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdarg>
#include <chrono>
#include <cmath>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <zlib.h>


#define REMOTE_HELLO "HELLO simutrans-remote "  ///< followed by the protocol version of the client
#define REMOTE_PROTOCOL_VERSION 2                ///< newest protocol; 1 = requests only, 2 = also events
#define MAX_REQUEST_LENGTH (4*1024*1024)
#define MAX_CLIENTS 8
#define MAX_REPLY_LENGTH (16*1024*1024)
#define MAX_PENDING_OUTPUT (32*1024*1024) ///< a client with more unsent replies is disconnected
#define MAX_PENDING_INPUT (8*1024*1024)   ///< a client with more received but not executed requests is disconnected
#define OUTPUT_STALL_TIMEOUT 60000        ///< ms without any progress in sending the replies until disconnect
#define HANDSHAKE_TIMEOUT 5000            ///< ms until a new connection must have sent the greeting
#define POLL_TIME_BUDGET_US 4000          ///< us per poll for executing requests (at least one per client)
#define HEAVY_START_US 1000               ///< a heavy request starts only this early in a poll, at most one per poll
#define MAX_QUEUED_TEXTS 1024             ///< text requests whose string events the game has not polled yet
#define MAX_QUEUED_TEXT_BYTES (16*1024*1024)


unsigned int remote_control_world_generation = 0;


// ---------------------------------------------------------------------------
// small JSON writer
// ---------------------------------------------------------------------------

class json_t
{
	std::string buf;
	std::vector<bool> first; ///< per nesting level: nothing written yet
	bool after_key = false;

	void sep()
	{
		if (after_key) {
			after_key = false;
			return;
		}
		if (!first.empty()) {
			if (!first.back()) {
				buf += ',';
			}
			first.back() = false;
		}
	}

	/// length of the valid UTF-8 sequence at p (p[0] >= 0x80), 0 if it is invalid (stops at the terminating 0)
	static size_t utf8_length(const unsigned char *p)
	{
		size_t len;
		unsigned char lo = 0x80, hi = 0xBF; // range of the second byte without overlong forms and surrogates
		if (p[0] >= 0xC2  &&  p[0] <= 0xDF) {
			len = 2;
		}
		else if (p[0] >= 0xE0  &&  p[0] <= 0xEF) {
			len = 3;
			lo = p[0] == 0xE0 ? 0xA0 : 0x80;
			hi = p[0] == 0xED ? 0x9F : 0xBF;
		}
		else if (p[0] >= 0xF0  &&  p[0] <= 0xF4) {
			len = 4;
			lo = p[0] == 0xF0 ? 0x90 : 0x80;
			hi = p[0] == 0xF4 ? 0x8F : 0xBF;
		}
		else {
			return 0;
		}
		if (p[1] < lo  ||  p[1] > hi) {
			return 0;
		}
		for (size_t i = 2; i < len; i++) {
			if ((p[i] & 0xC0) != 0x80) {
				return 0;
			}
		}
		return len;
	}

	void append_string(const char *s)
	{
		buf += '"';
		const unsigned char *p = (const unsigned char *)s;
		while (true) {
			// copy runs of characters that need no escaping at once
			const unsigned char *run = p;
			while (true) {
				if (*p >= 0x20  &&  *p < 0x80  &&  *p != '"'  &&  *p != '\\') {
					p++;
					continue;
				}
				const size_t len = *p >= 0x80 ? utf8_length(p) : 0;
				if (len == 0) {
					break;
				}
				p += len;
			}
			if (p > run) {
				buf.append((const char *)run, p - run);
			}
			if (*p == 0) {
				break;
			}
			if (*p >= 0x80) {
				// invalid UTF-8 (e.g. a game text cut in the middle of a character): JSON must be UTF-8
				buf += "\\ufffd";
				p++;
				continue;
			}
			switch (*p) {
				case '"':  buf += "\\\""; break;
				case '\\': buf += "\\\\"; break;
				case '\n': buf += "\\n"; break;
				case '\r': buf += "\\r"; break;
				case '\t': buf += "\\t"; break;
				default: {
					char u[8];
					snprintf(u, sizeof(u), "\\u%04x", *p);
					buf += u;
				}
			}
			p++;
		}
		buf += '"';
	}

	void append_int(sint64 v)
	{
		char digits[24];
		char *const end = digits + sizeof(digits);
		char *p = end;
		uint64 u = v < 0 ? (uint64)0 - (uint64)v : (uint64)v;
		do {
			*--p = (char)('0' + u % 10);
			u /= 10;
		} while (u);
		if (v < 0) {
			*--p = '-';
		}
		buf.append(p, end - p);
	}

public:
	json_t &obj()     { sep(); buf += '{'; first.push_back(true); return *this; }
	json_t &end_obj() { buf += '}'; first.pop_back(); return *this; }
	json_t &arr()     { sep(); buf += '['; first.push_back(true); return *this; }
	json_t &end_arr() { buf += ']'; first.pop_back(); return *this; }

	json_t &key(const char *k) { sep(); append_string(k); buf += ':'; after_key = true; return *this; }

	json_t &str(const char *s)
	{
		sep();
		if (s) {
			append_string(s);
		}
		else {
			buf += "null";
		}
		return *this;
	}
	json_t &num(sint64 v)
	{
		sep();
		append_int(v);
		return *this;
	}
	/// [v0,v1,...] as one array element or value: faster than arr() + num() for many small rows
	json_t &int_row(const int *v, int n)
	{
		sep();
		buf += '[';
		for (int i = 0; i < n; i++) {
			if (i) {
				buf += ',';
			}
			append_int(v[i]);
		}
		buf += ']';
		return *this;
	}
	json_t &dbl(double v)
	{
		sep();
		if (std::isfinite(v)) {
			char tmp[32];
			snprintf(tmp, sizeof(tmp), "%.15g", v);
			buf += tmp;
		}
		else {
			buf += "null";
		}
		return *this;
	}
	/// a value that is already JSON (e.g. a cached array)
	json_t &raw(const std::string &json)
	{
		sep();
		buf += json;
		return *this;
	}
	/// string of len characters that need no escaping (e.g. map rows)
	json_t &safe_str(const char *s, size_t len)
	{
		sep();
		buf += '"';
		buf.append(s, len);
		buf += '"';
		return *this;
	}
	json_t &boolean(bool b) { sep(); buf += b ? "true" : "false"; return *this; }
	json_t &null()          { sep(); buf += "null"; return *this; }

	// key/value shortcuts
	json_t &kv(const char *k, const char *v) { return key(k).str(v); }
	json_t &kv(const char *k, sint64 v)      { return key(k).num(v); }
	json_t &kv(const char *k, int v)         { return key(k).num(v); }
	json_t &kv(const char *k, uint32 v)      { return key(k).num(v); }
	json_t &kv(const char *k, double v)      { return key(k).dbl(v); }
	json_t &kv(const char *k, bool v)        { return key(k).boolean(v); }

	json_t &rect(scr_coord pos, scr_size size)
	{
		kv("x", (int)pos.x);
		kv("y", (int)pos.y);
		kv("w", (int)size.w);
		kv("h", (int)size.h);
		return *this;
	}

	/// starts again with an empty text, keeps the allocated memory
	void clear() { buf.clear(); first.clear(); after_key = false; }

	size_t size() const { return buf.size(); }
	const char *get() const { return buf.c_str(); }
	/// the reply text, may be taken over (swapped) when the reply is queued
	std::string &text() { return buf; }
};


// ---------------------------------------------------------------------------
// request arguments
// ---------------------------------------------------------------------------

typedef std::map<std::string, std::string> args_t;

static int hex_value(char c)
{
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}


static std::string url_decode(const std::string &s)
{
	std::string out;
	out.reserve(s.size());
	for (size_t i = 0; i < s.size(); i++) {
		if (s[i] == '+') {
			out += ' ';
		}
		else if (s[i] == '%' && i + 2 < s.size() && hex_value(s[i+1]) >= 0 && hex_value(s[i+2]) >= 0) {
			out += (char)(hex_value(s[i+1]) * 16 + hex_value(s[i+2]));
			i += 2;
		}
		else {
			out += s[i];
		}
	}
	return out;
}


static void parse_args(const std::string &query, args_t &args)
{
	size_t start = 0;
	while (start < query.size()) {
		size_t end = query.find('&', start);
		if (end == std::string::npos) {
			end = query.size();
		}
		const std::string pair = query.substr(start, end - start);
		if (!pair.empty()) {
			const size_t eq = pair.find('=');
			if (eq == std::string::npos) {
				args[url_decode(pair)] = "";
			}
			else {
				args[url_decode(pair.substr(0, eq))] = url_decode(pair.substr(eq + 1));
			}
		}
		start = end + 1;
	}
}


static bool has_arg(const args_t &a, const char *k)
{
	return a.find(k) != a.end();
}


static std::string arg_str(const args_t &a, const char *k, const char *def = "")
{
	args_t::const_iterator it = a.find(k);
	return it == a.end() ? std::string(def) : it->second;
}


static sint64 arg_int(const args_t &a, const char *k, sint64 def)
{
	args_t::const_iterator it = a.find(k);
	if (it == a.end() || it->second.empty()) {
		return def;
	}
	return strtoll(it->second.c_str(), NULL, 10);
}


static bool arg_bool(const args_t &a, const char *k, bool def)
{
	args_t::const_iterator it = a.find(k);
	if (it == a.end() || it->second.empty()) {
		return def;
	}
	const std::string &v = it->second;
	return !(v == "0" || v == "false" || v == "no" || v == "off");
}


/// error messages with dynamic content are stored here until the reply is written
static std::string error_buffer;

static const char *make_error(const char *fmt, const char *detail)
{
	cbuffer_t buf;
	buf.printf(fmt, detail);
	error_buffer = buf.get_str();
	return error_buffer.c_str();
}


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// player number of an owner, -1 for nobody (PLAYER_UNOWNED)
static int owner_of(sint8 nr)
{
	return (nr < 0 || nr >= PLAYER_UNOWNED) ? -1 : nr;
}


/// monotonic clock in microseconds, for time budgets and measurements
static uint64 time_us()
{
	return (uint64)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}


static const char *obj_type_name(obj_t::typ t)
{
	switch (t) {
		case obj_t::baum:                return "tree";
		case obj_t::zeiger:              return "cursor";
		case obj_t::cloud:               return "cloud";
		case obj_t::gebaeude:            return "building";
		case obj_t::signal:              return "signal";
		case obj_t::bruecke:             return "bridge";
		case obj_t::tunnel:              return "tunnel";
		case obj_t::bahndepot:           return "rail_depot";
		case obj_t::strassendepot:       return "road_depot";
		case obj_t::schiffdepot:         return "ship_depot";
		case obj_t::leitung:             return "powerline";
		case obj_t::pumpe:               return "power_source";
		case obj_t::senke:               return "power_sink";
		case obj_t::roadsign:            return "roadsign";
		case obj_t::pillar:              return "pillar";
		case obj_t::airdepot:            return "air_depot";
		case obj_t::monoraildepot:       return "monorail_depot";
		case obj_t::tramdepot:           return "tram_depot";
		case obj_t::maglevdepot:         return "maglev_depot";
		case obj_t::narrowgaugedepot:    return "narrowgauge_depot";
		case obj_t::wayobj:              return "wayobj";
		case obj_t::way:                 return "way";
		case obj_t::label:               return "label";
		case obj_t::field:               return "field";
		case obj_t::crossing:            return "crossing";
		case obj_t::groundobj:           return "groundobj";
		case obj_t::pedestrian:          return "pedestrian";
		case obj_t::road_user:           return "citycar";
		case obj_t::road_vehicle:        return "road_vehicle";
		case obj_t::rail_vehicle:        return "rail_vehicle";
		case obj_t::monorail_vehicle:    return "monorail_vehicle";
		case obj_t::maglev_vehicle:      return "maglev_vehicle";
		case obj_t::narrowgauge_vehicle: return "narrowgauge_vehicle";
		case obj_t::water_vehicle:       return "ship";
		case obj_t::air_vehicle:         return "aircraft";
		case obj_t::movingobj:           return "movingobj";
		default:                         return "other";
	}
}


static void write_date(json_t &j, const char *k, uint32 months)
{
	j.key(k).obj();
	j.kv("year", (int)(months / 12));
	j.kv("month", (int)(months % 12 + 1));
	j.end_obj();
}


static void write_koord3d(json_t &j, const char *k, koord3d pos)
{
	j.key(k);
	if (pos == koord3d::invalid) {
		j.null();
		return;
	}
	j.obj().kv("x", (int)pos.x).kv("y", (int)pos.y).kv("z", (int)pos.z).end_obj();
}


static scr_coord current_mouse_pos;


static void queue_mouse(event_class_t cls, unsigned code, scr_coord pos, scr_coord click_pos, int buttons, unsigned mods)
{
	event_t *ev = new event_t(cls);
	ev->ev_code = code;
	ev->mouse_pos = pos;
	ev->click_pos = click_pos;
	ev->mouse_button_state = buttons;
	ev->ev_key_mod = mods;
	queue_event(ev);
	current_mouse_pos = pos;
}


static unsigned key_mods(const args_t &a)
{
	unsigned mods = SIM_KEYMOD_NONE;
	if (arg_bool(a, "shift", false)) {
		mods |= SIM_KEYMOD_SHIFT;
	}
	if (arg_bool(a, "ctrl", false)) {
		mods |= SIM_KEYMOD_CTRL;
	}
	return mods;
}


static bool parse_button(const args_t &a, unsigned &code)
{
	const std::string b = arg_str(a, "button", "left");
	if (b == "left") {
		code = MOUSE_LEFTBUTTON;
	}
	else if (b == "right") {
		code = MOUSE_RIGHTBUTTON;
	}
	else if (b == "middle") {
		code = MOUSE_MIDBUTTON;
	}
	else {
		return false;
	}
	return true;
}


static const char *get_screen_pos(const args_t &a, const char *kx, const char *ky, scr_coord &pos)
{
	if (!has_arg(a, kx) || !has_arg(a, ky)) {
		return "missing screen coordinates";
	}
	const scr_size screen = gfx->get_screen_size();
	pos.x = (scr_coord_val)arg_int(a, kx, 0);
	pos.y = (scr_coord_val)arg_int(a, ky, 0);
	if (pos.x < 0 || pos.y < 0 || pos.x >= screen.w || pos.y >= screen.h) {
		return "screen coordinates outside of the window";
	}
	return NULL;
}


/// tile position from x,y[,z] (or other argument names); if z is missing the ground height is used
static const char *get_tile_pos(const args_t &a, koord3d &pos, const char *kx = "x", const char *ky = "y", const char *kz = "z")
{
	karte_t *welt = world();
	if (!has_arg(a, kx) || !has_arg(a, ky)) {
		return make_error("missing tile coordinates %s", (std::string(kx) + "," + ky).c_str());
	}
	const koord k((sint16)arg_int(a, kx, 0), (sint16)arg_int(a, ky, 0));
	if (!welt->is_within_limits(k)) {
		return "tile coordinates outside of the map";
	}
	if (has_arg(a, kz)) {
		pos = koord3d(k, (sint8)arg_int(a, kz, 0));
	}
	else {
		const grund_t *gr = welt->lookup_kartenboden(k);
		pos = gr ? gr->get_pos() : koord3d(k, welt->get_groundwater());
	}
	return NULL;
}


// ---------------------------------------------------------------------------
// GUI inspection
// ---------------------------------------------------------------------------

static void write_element(json_t &j, const char *type, const char *text, scr_coord pos, scr_size size)
{
	j.obj();
	j.kv("type", type);
	if (text) {
		j.kv("text", text);
	}
	j.rect(pos, size);
	j.end_obj();
}


static void write_components(json_t &j, gui_component_t *comp, scr_coord offset, scr_rect clip, int &budget, int depth)
{
	if (comp == NULL || !comp->is_visible() || budget <= 0 || depth > 40) {
		return;
	}
	const scr_coord pos = offset + comp->get_pos();
	const scr_size size = comp->get_size();
	const scr_rect area(pos, size);

	if (!clip.is_overlapping(area)) {
		return;
	}

	if (button_t *b = dynamic_cast<button_t *>(comp)) {
		j.obj();
		j.kv("type", "button");
		const char *text = b->get_text();
		if (text && *text) {
			j.kv("text", translator::translate(text));
		}
		j.kv("pressed", b->pressed);
		j.kv("enabled", b->enabled());
		j.rect(pos, size);
		j.end_obj();
		budget--;
		return;
	}
	if (gui_textinput_t *t = dynamic_cast<gui_textinput_t *>(comp)) {
		write_element(j, "textinput", t->get_text(), pos, size);
		budget--;
		return;
	}
	if (gui_label_t *l = dynamic_cast<gui_label_t *>(comp)) {
		const char *text = l->get_text_pointer();
		if (text && *text) {
			write_element(j, "label", text, pos, size);
			budget--;
		}
		return;
	}
	if (gui_scrolled_list_t::scrollitem_t *item = dynamic_cast<gui_scrolled_list_t::scrollitem_t *>(comp)) {
		write_element(j, "listitem", item->get_text(), pos, size);
		budget--;
		return;
	}
	if (gui_tab_panel_t *tabs = dynamic_cast<gui_tab_panel_t *>(comp)) {
		vector_tpl<gui_tab_panel_t::tab_header_t> headers;
		tabs->get_tab_headers(headers);
		for (gui_tab_panel_t::tab_header_t const &h : headers) {
			j.obj();
			j.kv("type", "tab");
			j.kv("text", h.title ? h.title : h.tooltip);
			j.kv("active", h.active);
			j.rect(pos + h.area.get_pos(), h.area.get_size());
			j.end_obj();
			budget--;
		}
		write_components(j, tabs->get_aktives_tab(), pos, clip, budget, depth + 1);
		return;
	}
	if (gui_scrollpane_t *sp = dynamic_cast<gui_scrollpane_t *>(comp)) {
		scr_rect inner = clip;
		inner.clip(area);
		write_components(j, sp->get_component(), pos - scr_coord(sp->get_scroll_x(), sp->get_scroll_y()), inner, budget, depth + 1);
		return;
	}
	if (gui_container_t *c = dynamic_cast<gui_container_t *>(comp)) {
		for (gui_component_t *child : c->get_components()) {
			write_components(j, child, pos, clip, budget, depth + 1);
		}
	}
}


static void write_windows(json_t &j, bool with_components, int max_elements)
{
	j.key("windows").arr();
	gui_frame_t *top = win_get_top();
	const uint32 count = win_get_open_count();
	for (uint32 i = 0; i < count; i++) {
		gui_frame_t *gui = win_get_index(i);
		if (gui == NULL) {
			continue;
		}
		const scr_coord pos = win_get_pos(gui);
		const scr_size size = gui->get_windowsize();
		j.obj();
		j.kv("index", i);
		j.kv("title", gui->get_name() ? translator::translate(gui->get_name()) : "");
		j.kv("top", gui == top);
		j.rect(pos, size);
		if (with_components) {
			const scr_coord_val title_h = gui->has_title() ? D_TITLEBAR_HEIGHT : 0;
			int budget = max_elements;
			j.key("elements").arr();
			for (gui_component_t *child : gui->get_components()) {
				write_components(j, child, pos + scr_coord(0, title_h), scr_rect(pos, size), budget, 0);
			}
			j.end_arr();
			if (budget <= 0) {
				j.kv("truncated", true);
			}
		}
		j.end_obj();
	}
	j.end_arr();
}


// ---------------------------------------------------------------------------
// squirrel evaluation
// ---------------------------------------------------------------------------

static script_vm_t *eval_vm = NULL;
static std::string script_error;


static void remote_compile_error(HSQUIRRELVM, const SQChar *desc, const SQChar *source, SQInteger line, SQInteger column)
{
	cbuffer_t buf;
	buf.printf("compile error in %s line %d column %d: %s", source ? source : "?", (int)line, (int)column, desc ? desc : "?");
	script_error = buf.get_str();
}


static SQInteger remote_runtime_error(HSQUIRRELVM vm)
{
	cbuffer_t buf;
	const SQChar *msg = NULL;
	if (sq_gettop(vm) >= 2) {
		sq_tostring(vm, 2);
		sq_getstring(vm, -1, &msg);
		buf.append(msg ? msg : "unknown error");
		sq_pop(vm, 1);
	}
	else {
		buf.append("unknown error");
	}
	SQStackInfos si;
	for (SQInteger level = 1; level < 16 && SQ_SUCCEEDED(sq_stackinfos(vm, level, &si)); level++) {
		buf.printf("\n  at %s (%s:%d)", si.funcname ? si.funcname : "<anonymous>", si.source ? si.source : "?", (int)si.line);
	}
	script_error = buf.get_str();
	return 0;
}


static void reset_eval_vm()
{
	delete eval_vm;
	eval_vm = NULL;
}


/// constructor of command_x in the eval VM: the original one (free variable), but without the scripted tools
static SQInteger eval_command_constructor(HSQUIRRELVM vm)
{
	// stack: 1 instance, 2 tool id, 3 original constructor
	SQInteger id = 0;
	sq_getinteger(vm, 2, &id);
	const SQInteger nr = id & 0x0FFF;
	if (nr == TOOL_EXEC_SCRIPT  ||  nr == TOOL_EXEC_TWO_CLICK_SCRIPT) {
		// they load tool.nut from any directory (also \\host\share\...) into a VM with the full system library
		return sq_throwerror(vm, "scripted tools cannot be used through the remote control");
	}
	sq_push(vm, 3);
	sq_push(vm, 1);
	sq_push(vm, 2);
	if (SQ_FAILED(sq_call(vm, 2, SQFalse, SQFalse))) {
		return SQ_ERROR; // the error of the original constructor
	}
	return 0;
}


/// replaces the constructor of command_x by eval_command_constructor, false on failure
static bool block_scripted_tools(HSQUIRRELVM vm)
{
	bool ok = false;
	sq_pushroottable(vm);
	sq_pushstring(vm, "command_x", -1);
	if (SQ_SUCCEEDED(sq_get(vm, -2))) {
		sq_pushstring(vm, "constructor", -1);
		if (SQ_SUCCEEDED(sq_rawget(vm, -2))) {
			// stack: root, command_x, original constructor (becomes the free variable)
			sq_newclosure(vm, eval_command_constructor, 1);
			sq_setparamscheck(vm, 2, "xi");
			sq_pushstring(vm, "constructor", -1);
			sq_push(vm, -2);
			ok = SQ_SUCCEEDED(sq_newslot(vm, -4, SQFalse));
			sq_pop(vm, 1);
		}
		sq_pop(vm, 1);
	}
	sq_pop(vm, 1);
	return ok;
}


static script_vm_t *get_eval_vm()
{
	if (eval_vm == NULL) {
		eval_vm = script_loader_t::start_vm("tool_base.nut", "script-remote.log", ".", false);
		if (eval_vm) {
			HSQUIRRELVM vm = eval_vm->get_vm();
			// report errors back to the client instead of opening error windows
			sq_setcompilererrorhandler(vm, remote_compile_error);
			sq_newclosure(vm, remote_runtime_error, 0);
			sq_seterrorhandler(vm);
			// tool calls must not suspend (only relevant in network games)
			sq_block_suspend(vm, "remote control");
			// remote code must not run programs or touch files: remove these functions of the
			// system library (clock, time and date stay; include() only loads .nut scripts)
			static const char *const forbidden[] = { "system", "remove", "rename", "getenv" };
			sq_pushroottable(vm);
			for (const char *name : forbidden) {
				sq_pushstring(vm, name, -1);
				sq_deleteslot(vm, -2, SQFalse); // pops the key, also if the slot does not exist
			}
			sq_pop(vm, 1);
			// command_x(tool_exec_script).work(pl, pos, "<any directory>") would run that tool.nut with system()
			if (!block_scripted_tools(vm)) {
				dbg->error("remote_control", "could not restrict command_x in the script engine");
				reset_eval_vm();
			}
		}
	}
	return eval_vm;
}


static void write_sq_value(json_t &j, HSQUIRRELVM vm, SQInteger idx, int depth)
{
	if (idx < 0) {
		idx = sq_gettop(vm) + idx + 1;
	}
	if (depth > 24 || j.size() > MAX_REPLY_LENGTH) {
		j.str("<truncated>");
		return;
	}
	switch (sq_gettype(vm, idx)) {
		case OT_NULL:
			j.null();
			return;
		case OT_INTEGER: {
			SQInteger i;
			sq_getinteger(vm, idx, &i);
			j.num(i);
			return;
		}
		case OT_FLOAT: {
			SQFloat f;
			sq_getfloat(vm, idx, &f);
			j.dbl(f);
			return;
		}
		case OT_BOOL: {
			SQBool b;
			sq_getbool(vm, idx, &b);
			j.boolean(b != 0);
			return;
		}
		case OT_STRING: {
			const SQChar *s = NULL;
			sq_getstring(vm, idx, &s);
			j.str(s);
			return;
		}
		case OT_ARRAY: {
			j.arr();
			sq_pushnull(vm);
			while (SQ_SUCCEEDED(sq_next(vm, idx))) {
				write_sq_value(j, vm, -1, depth + 1);
				sq_pop(vm, 2);
			}
			sq_pop(vm, 1);
			j.end_arr();
			return;
		}
		case OT_TABLE: {
			j.obj();
			sq_pushnull(vm);
			while (SQ_SUCCEEDED(sq_next(vm, idx))) {
				const SQChar *k = NULL;
				sq_tostring(vm, -2);
				sq_getstring(vm, -1, &k);
				j.key(k ? k : "?");
				sq_pop(vm, 1);
				write_sq_value(j, vm, -1, depth + 1);
				sq_pop(vm, 2);
			}
			sq_pop(vm, 1);
			j.end_obj();
			return;
		}
		case OT_INSTANCE: {
			// write the scalar data members, e.g. x,y,z of coord, tile_x, city_x, ...
			// instances cannot be iterated directly: iterate the member names of the class
			bool any = false;
			if (SQ_SUCCEEDED(sq_getclass(vm, idx))) {
				const SQInteger cls = sq_gettop(vm);
				sq_pushnull(vm);
				// stack: class, iterator
				while (SQ_SUCCEEDED(sq_next(vm, cls))) {
					// stack: class, iterator, key, default value
					sq_pop(vm, 1);
					sq_push(vm, -1);
					// stack: class, iterator, key, key
					if (SQ_SUCCEEDED(sq_get(vm, idx))) {
						// stack: class, iterator, key, value
						const SQObjectType t = sq_gettype(vm, -1);
						const SQChar *k = NULL;
						if ((t == OT_INTEGER || t == OT_FLOAT || t == OT_BOOL || t == OT_STRING) && SQ_SUCCEEDED(sq_getstring(vm, -2, &k))) {
							if (!any) {
								j.obj();
								any = true;
							}
							j.key(k);
							write_sq_value(j, vm, -1, depth + 1);
						}
						sq_pop(vm, 1);
					}
					// stack: class, iterator, key
					sq_pop(vm, 1);
				}
				sq_pop(vm, 2);
			}
			if (any) {
				j.end_obj();
				return;
			}
			break;
		}
		default:
			break;
	}
	// everything else: string representation
	const SQChar *s = NULL;
	sq_tostring(vm, idx);
	sq_getstring(vm, -1, &s);
	j.str(s);
	sq_pop(vm, 1);
}


// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

typedef const char *(*command_fn)(const args_t &a, json_t &j);


static const char *cmd_ping(const args_t &, json_t &j)
{
	j.kv("pong", true);
	return NULL;
}


/// time multiplier of "fast forward" in network games (16 = normal speed): the server and all clients run
/// in lock step, so the game runs this much faster instead of as fast as possible
static const sint32 NETWORK_FAST_FORWARD_MULTIPLIER = 4 * 16;

/// fast forward on: in single player the fast forward mode, in network games a faster time multiplier
static bool fast_forward_on()
{
	karte_t *welt = world();
	return env_t::networkmode ? welt->get_time_multiplier() > 16 : welt->is_fast_forward();
}


static const char *cmd_status(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const scr_size screen = gfx->get_screen_size();

	j.key("game").obj();
	j.kv("pakset", env_t::pak_name.c_str());
	j.kv("networkmode", env_t::networkmode);
	j.kv("server", env_t::server != 0);
	j.kv("player_change_allowed", welt->get_settings().get_allow_player_change() != 0);
	j.end_obj();

	j.key("screen").obj();
	j.kv("w", (int)screen.w);
	j.kv("h", (int)screen.h);
	j.kv("tile_raster_width", (int)gfx->get_tile_raster_width());
	j.kv("zoom_index", (int)gfx->get_zoom_factor());
	j.end_obj();

	j.key("world").obj();
	j.kv("size_x", (int)welt->get_size().x);
	j.kv("size_y", (int)welt->get_size().y);
	write_date(j, "date", welt->get_current_month());
	j.kv("ticks", (sint64)welt->get_ticks());
	j.kv("paused", welt->is_paused());
	j.kv("fast_forward", fast_forward_on());
	j.kv("time_multiplier", (int)welt->get_time_multiplier());
	j.kv("rotation", (int)welt->get_settings().get_rotation());
	j.kv("cities", (uint32)welt->get_cities().get_count());
	j.kv("convoys", (uint32)welt->convoys().get_count());
	j.end_obj();

	scenario_t *scen = welt->get_scenario();
	j.key("scenario").obj();
	j.kv("active", scen && scen->is_scripted());
	if (scen && scen->is_scripted()) {
		j.kv("path", scen->get_scenario_path());
	}
	j.end_obj();

	player_t *player = welt->get_active_player();
	j.key("player").obj();
	if (player) {
		j.kv("nr", (int)player->get_player_nr());
		j.kv("name", player->get_name());
		j.kv("cash", (double)player->get_finance()->get_account_balance() / 100.0);
		j.kv("net_wealth", (double)player->get_finance()->get_netwealth() / 100.0);
	}
	j.end_obj();

	tool_t *tool = player ? welt->get_tool(player->get_player_nr()) : NULL;
	j.key("tool").obj();
	if (tool) {
		j.kv("id", (int)tool->get_id());
		j.kv("tooltip", tool->get_tooltip(player));
		j.kv("default_param", tool->get_default_param());
	}
	j.end_obj();

	viewport_t *view = welt->get_viewport();
	j.key("view").obj();
	const koord center = view->get_world_position();
	const grund_t *gr = welt->lookup_kartenboden(center);
	write_koord3d(j, "center", gr ? gr->get_pos() : koord3d(center, 0));
	write_koord3d(j, "cursor", welt->get_zeiger()->get_pos());
	j.kv("underground_mode", (int)grund_t::underground_mode);
	j.end_obj();

	write_windows(j, arg_bool(a, "components", false), (int)arg_int(a, "max_elements", 300));
	return NULL;
}


static const char *cmd_windows(const args_t &a, json_t &j)
{
	write_windows(j, arg_bool(a, "components", true), (int)arg_int(a, "max_elements", 300));
	return NULL;
}


static const char *cmd_click(const args_t &a, json_t &j)
{
	scr_coord pos;
	if (const char *err = get_screen_pos(a, "x", "y", pos)) {
		return err;
	}
	unsigned code;
	if (!parse_button(a, code)) {
		return "button must be left, right or middle";
	}
	const unsigned mods = key_mods(a);
	const int count = (int)clamp<sint64>(arg_int(a, "count", 1), 1, 3);

	queue_mouse(EVENT_MOVE, 0, pos, pos, 0, mods);
	for (int i = 0; i < count; i++) {
		queue_mouse(EVENT_CLICK, code, pos, pos, code, mods);
		queue_mouse(EVENT_RELEASE, code, pos, pos, 0, mods);
	}
	if (count == 2) {
		queue_mouse(EVENT_DOUBLE_CLICK, code, pos, pos, 0, mods);
	}
	else if (count == 3) {
		queue_mouse(EVENT_TRIPLE_CLICK, code, pos, pos, 0, mods);
	}
	set_click_xy(pos.x, pos.y);
	j.kv("queued", true);
	return NULL;
}


static const char *cmd_move(const args_t &a, json_t &j)
{
	scr_coord pos;
	if (const char *err = get_screen_pos(a, "x", "y", pos)) {
		return err;
	}
	queue_mouse(EVENT_MOVE, 0, pos, pos, 0, key_mods(a));
	j.kv("queued", true);
	return NULL;
}


static const char *cmd_drag(const args_t &a, json_t &j)
{
	scr_coord from, to;
	if (const char *err = get_screen_pos(a, "x1", "y1", from)) {
		return err;
	}
	if (const char *err = get_screen_pos(a, "x2", "y2", to)) {
		return err;
	}
	unsigned code;
	if (!parse_button(a, code)) {
		return "button must be left, right or middle";
	}
	const unsigned mods = key_mods(a);
	const int steps = (int)clamp<sint64>(arg_int(a, "steps", 10), 1, 100);

	queue_mouse(EVENT_MOVE, 0, from, from, 0, mods);
	queue_mouse(EVENT_CLICK, code, from, from, code, mods);
	for (int i = 1; i <= steps; i++) {
		const scr_coord p(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
		queue_mouse(EVENT_DRAG, code, p, from, code, mods);
	}
	queue_mouse(EVENT_RELEASE, code, to, from, 0, mods);
	set_click_xy(from.x, from.y);
	j.kv("queued", true);
	return NULL;
}


static const char *cmd_wheel(const args_t &a, json_t &j)
{
	scr_coord pos;
	if (const char *err = get_screen_pos(a, "x", "y", pos)) {
		return err;
	}
	const std::string dir = arg_str(a, "dir", "up");
	if (dir != "up" && dir != "down") {
		return "dir must be up or down";
	}
	const unsigned code = dir == "up" ? MOUSE_WHEELUP : MOUSE_WHEELDOWN;
	const int count = (int)clamp<sint64>(arg_int(a, "count", 1), 1, 20);
	queue_mouse(EVENT_MOVE, 0, pos, pos, 0, key_mods(a));
	for (int i = 0; i < count; i++) {
		queue_mouse(EVENT_CLICK, code, pos, pos, 0, key_mods(a));
	}
	j.kv("queued", true);
	return NULL;
}


struct named_key_t
{
	const char *name;
	unsigned code;
};

static const named_key_t named_keys[] = {
	{ "backspace", SIM_KEYCODE_BACKSPACE },
	{ "tab",       SIM_KEYCODE_TAB },
	{ "enter",     SIM_KEYCODE_ENTER },
	{ "return",    SIM_KEYCODE_ENTER },
	{ "escape",    SIM_KEYCODE_ESCAPE },
	{ "esc",       SIM_KEYCODE_ESCAPE },
	{ "space",     SIM_KEYCODE_SPACE },
	{ "delete",    SIM_KEYCODE_DELETE },
	{ "home",      SIM_KEYCODE_HOME },
	{ "end",       SIM_KEYCODE_END },
	{ "pageup",    SIM_KEYCODE_PGUP },
	{ "pagedown",  SIM_KEYCODE_PGDN },
	{ "up",        SIM_KEYCODE_UP },
	{ "down",      SIM_KEYCODE_DOWN },
	{ "left",      SIM_KEYCODE_LEFT },
	{ "right",     SIM_KEYCODE_RIGHT },
	{ "f1",  SIM_KEYCODE_F1 },  { "f2",  SIM_KEYCODE_F2 },  { "f3",  SIM_KEYCODE_F3 },
	{ "f4",  SIM_KEYCODE_F4 },  { "f5",  SIM_KEYCODE_F5 },  { "f6",  SIM_KEYCODE_F6 },
	{ "f7",  SIM_KEYCODE_F7 },  { "f8",  SIM_KEYCODE_F8 },  { "f9",  SIM_KEYCODE_F9 },
	{ "f10", SIM_KEYCODE_F10 }, { "f11", SIM_KEYCODE_F11 }, { "f12", SIM_KEYCODE_F12 },
	{ "f13", SIM_KEYCODE_F13 }, { "f14", SIM_KEYCODE_F14 }, { "f15", SIM_KEYCODE_F15 },
};


/// decodes the first UTF-8 character of s, returns 0 if s is not a single character
static unsigned single_utf8_char(const std::string &s)
{
	const unsigned char *p = (const unsigned char *)s.c_str();
	unsigned c;
	size_t len;
	if (p[0] < 0x80)              { c = p[0];        len = 1; }
	else if ((p[0] & 0xE0) == 0xC0) { c = p[0] & 0x1F; len = 2; }
	else if ((p[0] & 0xF0) == 0xE0) { c = p[0] & 0x0F; len = 3; }
	else if ((p[0] & 0xF8) == 0xF0) { c = p[0] & 0x07; len = 4; }
	else {
		return 0;
	}
	if (s.size() != len) {
		return 0;
	}
	for (size_t i = 1; i < len; i++) {
		if ((p[i] & 0xC0) != 0x80) {
			return 0;
		}
		c = (c << 6) | (p[i] & 0x3F);
	}
	return c;
}


static const char *cmd_key(const args_t &a, json_t &j)
{
	const std::string key = arg_str(a, "key");
	if (key.empty()) {
		return "missing key";
	}
	unsigned code = 0;
	std::string lower = key;
	for (char &c : lower) {
		c = (char)tolower((unsigned char)c);
	}
	if (key.size() > 1) {
		for (named_key_t const &nk : named_keys) {
			if (lower == nk.name) {
				code = nk.code;
				break;
			}
		}
	}
	if (code == 0) {
		code = single_utf8_char(key);
	}
	if (code == 0) {
		return make_error("unknown key '%s'", key.c_str());
	}
	const int count = (int)clamp<sint64>(arg_int(a, "count", 1), 1, 50);
	for (int i = 0; i < count; i++) {
		event_t *ev = new event_t(EVENT_KEYDOWN);
		ev->ev_code = code;
		ev->ev_key_mod = key_mods(a);
		ev->mouse_pos = current_mouse_pos;
		ev->click_pos = current_mouse_pos;
		queue_event(ev);
	}
	j.kv("queued", true);
	j.kv("code", (int)code);
	return NULL;
}


static const char *cmd_text(const args_t &a, json_t &j)
{
	// A queued string event keeps a pointer to its text, so each text is kept until its event has
	// left the event queue. Many requests can run before the queue is drained (several polls per
	// frame), so a fixed ring of texts could be overwritten too early. The queue is first in, first
	// out and the texts are queued in order: once the oldest text is no longer queued, it was polled.
	// A deque never moves its elements when adding at the back or removing at the front.
	static std::deque<std::string> texts;
	static size_t text_bytes = 0;

	const std::string text = arg_str(a, "text");
	if (text.empty()) {
		return "missing text";
	}
	while (!texts.empty()  &&  !is_string_event_queued(texts.front().c_str())) {
		text_bytes -= texts.front().size();
		texts.pop_front();
	}
	if (texts.size() >= MAX_QUEUED_TEXTS  ||  text_bytes + text.size() > MAX_QUEUED_TEXT_BYTES) {
		return "too many texts are waiting for the game to process them, retry later";
	}
	texts.push_back(text);
	text_bytes += text.size();

	event_t *ev = new event_t(EVENT_STRING);
	ev->ev_ptr = (void *)texts.back().c_str();
	ev->mouse_pos = current_mouse_pos;
	ev->click_pos = current_mouse_pos;
	queue_event(ev);
	j.kv("queued", true);
	return NULL;
}


static const char *cmd_screenshot(const args_t &a, json_t &j)
{
	const std::string path = arg_str(a, "path");
	if (path.empty()) {
		return "missing path";
	}
	const bool sep0 = path[0] == '\\'  ||  path[0] == '/';
	if ((path.size() >= 2  &&  sep0  &&  (path[1] == '\\'  ||  path[1] == '/'))
		||  (path.size() >= 4  &&  sep0  &&  path[1] == '?'  &&  path[2] == '?'  &&  (path[3] == '\\'  ||  path[3] == '/'))) {
		// \\host\share\..., //host/... or \??\UNC\host\... (Windows passes \??\ paths on unchanged):
		// writing (and reading back) could reach other computers
		return "network paths (\\\\host\\..., //host/... or \\??\\...) are not allowed";
	}
	const scr_size screen = gfx->get_screen_size();
	scr_rect area(0, 0, screen.w, screen.h);
	if (has_arg(a, "w") && has_arg(a, "h")) {
		area = scr_rect((scr_coord_val)arg_int(a, "x", 0), (scr_coord_val)arg_int(a, "y", 0), (scr_coord_val)arg_int(a, "w", 0), (scr_coord_val)arg_int(a, "h", 0));
		area.clip(scr_rect(0, 0, screen.w, screen.h));
		if (area.w <= 0 || area.h <= 0) {
			return "screenshot area is outside of the window";
		}
	}
	if (!gfx->take_screenshot(area, path.c_str())) {
		return make_error("could not write screenshot to %s", path.c_str());
	}

	uint32 width = area.w, height = area.h;
	const int scale = (int)clamp<sint64>(arg_int(a, "scale", 1), 1, 8);
	if (scale > 1) {
		raw_image_t src;
		if (!src.read_from_file(path.c_str())) {
			return "could not read back screenshot for scaling";
		}
		const uint32 bytes = src.get_bpp() / 8;
		width = src.get_width() / scale;
		height = src.get_height() / scale;
		if (width == 0 || height == 0) {
			return "screenshot area too small for this scale";
		}
		raw_image_t dst(width, height, raw_image_t::FMT_RGB888);
		for (uint32 y = 0; y < height; y++) {
			for (uint32 x = 0; x < width; x++) {
				uint32 sum[3] = { 0, 0, 0 };
				for (int dy = 0; dy < scale; dy++) {
					for (int dx = 0; dx < scale; dx++) {
						const uint8 *p = src.access_pixel(x * scale + dx, y * scale + dy);
						for (int c = 0; c < 3; c++) {
							sum[c] += bytes >= 3 ? p[c] : p[0];
						}
					}
				}
				uint8 *d = dst.access_pixel(x, y);
				for (int c = 0; c < 3; c++) {
					d[c] = (uint8)(sum[c] / (scale * scale));
				}
			}
		}
		if (!dst.write_png(path.c_str())) {
			return "could not write scaled screenshot";
		}
	}
	j.kv("path", path.c_str());
	j.kv("x", (int)area.x);
	j.kv("y", (int)area.y);
	j.kv("width", width);
	j.kv("height", height);
	j.kv("scale", scale);
	return NULL;
}


static const char *cmd_view(const args_t &a, json_t &j)
{
	koord3d pos;
	if (const char *err = get_tile_pos(a, pos)) {
		return err;
	}
	world()->get_viewport()->change_world_position(pos);
	write_koord3d(j, "center", pos);
	return NULL;
}


static const char *cmd_tile_at(const args_t &a, json_t &j)
{
	scr_coord pos;
	if (const char *err = get_screen_pos(a, "x", "y", pos)) {
		return err;
	}
	const koord3d tile = world()->get_viewport()->get_new_cursor_position(pos, false);
	write_koord3d(j, "tile", tile);
	return NULL;
}


static const char *cmd_screen_pos(const args_t &a, json_t &j)
{
	koord3d pos;
	if (const char *err = get_tile_pos(a, pos)) {
		return err;
	}
	viewport_t *view = world()->get_viewport();
	const scr_coord_val raster = gfx->get_tile_raster_width();
	const scr_coord origin = view->get_screen_coord(pos);
	const scr_coord center(origin.x + raster / 2, origin.y + (raster * 3) / 4);
	const scr_size screen = gfx->get_screen_size();
	write_koord3d(j, "tile", pos);
	j.kv("x", (int)center.x);
	j.kv("y", (int)center.y);
	j.kv("on_screen", center.x >= 0 && center.y >= 0 && center.x < screen.w && center.y < screen.h);
	j.kv("tile_raster_width", (int)raster);
	return NULL;
}


static const char *cmd_tile(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	if (!has_arg(a, "x") || !has_arg(a, "y")) {
		return "missing tile coordinates x,y";
	}
	const koord k((sint16)arg_int(a, "x", 0), (sint16)arg_int(a, "y", 0));
	const planquadrat_t *plan = welt->access(k);
	if (plan == NULL) {
		return "tile coordinates outside of the map";
	}
	j.key("grounds").arr();
	for (unsigned i = 0; i < plan->get_boden_count(); i++) {
		grund_t *gr = plan->get_boden_bei(i);
		j.obj();
		write_koord3d(j, "pos", gr->get_pos());
		j.kv("type", gr->get_name());
		j.kv("surface", gr->ist_karten_boden());
		j.kv("water", gr->is_water());
		j.kv("slope", (int)gr->get_grund_hang());
		if (const char *text = gr->get_text()) {
			j.kv("text", text);
		}
		const halthandle_t halt = gr->get_halt();
		if (halt.is_bound()) {
			j.kv("halt", halt->get_name());
		}
		j.key("objects").arr();
		for (uint8 n = 0; n < gr->obj_count(); n++) {
			obj_t *obj = gr->obj_bei(n);
			if (obj == NULL || obj->get_typ() == obj_t::zeiger) {
				continue;
			}
			j.obj();
			j.kv("type", obj_type_name(obj->get_typ()));
			j.kv("name", obj->get_name());
			j.kv("owner", owner_of(obj->get_owner_nr()));
			j.end_obj();
		}
		j.end_arr();
		j.end_obj();
	}
	j.end_arr();

	if (const stadt_t *city = welt->find_nearest_city(k)) {
		const koord lo = city->get_linksoben();
		const koord ur = city->get_rechtsunten();
		const bool inside = lo.x <= k.x && k.x <= ur.x && lo.y <= k.y && k.y <= ur.y;
		j.key(inside ? "city" : "nearest_city").obj();
		j.kv("name", city->get_name());
		j.kv("citizens", (sint64)city->get_einwohner());
		j.end_obj();
	}
	return NULL;
}


static const char *message_type_name(int type)
{
	static const char *const names[] = {
		"general", "ai", "city", "problems", "industry", "chat", "new_vehicle", "full", "warnings",
		"traffic_jams", "scenario", "chat_common", "chat_company", "chat_private"
	};
	return type >= 0 && type < (int)(sizeof(names) / sizeof(names[0])) ? names[type] : "unknown";
}


static void write_message(json_t &j, const message_node_t *node, uint32 seq)
{
	const int type = node->type & message_t::MESSAGE_TYPE_MASK;
	int player = -1;
	if (node->color & PLAYER_FLAG) {
		const uint32 nr = node->color & ~PLAYER_FLAG;
		player = nr < MAX_PLAYER_COUNT ? (int)nr : -1;
	}
	j.obj();
	j.kv("seq", seq);
	j.kv("text", node->msg);
	j.kv("type", type);
	j.kv("type_name", message_type_name(type));
	j.kv("player", player);
	write_date(j, "date", (uint32)node->time);
	write_koord3d(j, "pos", node->pos);
	j.end_obj();
}


/**
 * Messages of the message center. New messages are inserted at the head of the list and only
 * removed when a world is loaded or created, so the i-th message from the head has seq = count - i.
 * Without since: the newest count messages, newest first. With since=<seq>: the messages after it,
 * oldest first; reset=true if since is beyond the newest message (the list was replaced).
 */
static const char *cmd_messages(const args_t &a, json_t &j)
{
	const slist_tpl<message_node_t *> &list = world()->get_message()->get_list();
	const uint32 newest = list.get_count();
	j.kv("seq", newest);
	if (!has_arg(a, "since")) {
		const int count = (int)clamp<sint64>(arg_int(a, "count", 20), 1, 500);
		int n = 0;
		j.key("messages").arr();
		for (message_node_t *node : list) {
			if (n >= count) {
				break;
			}
			write_message(j, node, newest - n);
			n++;
		}
		j.end_arr();
		return NULL;
	}

	const uint32 count = (uint32)clamp<sint64>(arg_int(a, "count", 100), 1, 500);
	sint64 since = arg_int(a, "since", 0);
	const bool reset = since < 0  ||  since > (sint64)newest;
	if (reset) {
		since = 0;
	}
	const uint32 fresh = newest - (uint32)since;
	const uint32 n = fresh < count ? fresh : count;
	// the n newest messages are the first n of the list, written oldest first
	vector_tpl<const message_node_t *> nodes(n);
	for (message_node_t *node : list) {
		if (nodes.get_count() >= n) {
			break;
		}
		nodes.append(node);
	}
	j.key("messages").arr();
	for (uint32 i = nodes.get_count(); i-- > 0; ) {
		write_message(j, nodes[i], newest - i);
	}
	j.end_arr();
	j.kv("truncated", fresh > count);
	j.kv("reset", reset);
	return NULL;
}


static const char *cmd_pause(const args_t &a, json_t &j)
{
	if (env_t::networkmode  &&  !env_t::server) {
		return "not available on a network client (the server controls the time)";
	}
	// on a server: it stops sending steps, so its clients wait (a client that joins resumes the game)
	karte_t *welt = world();
	welt->set_pause(arg_bool(a, "on", !welt->is_paused()));
	j.kv("paused", welt->is_paused());
	return NULL;
}


static const char *cmd_fast_forward(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	if (env_t::networkmode) {
		if (!env_t::server) {
			return "not available on a network client (the server controls the time)";
		}
		// a faster time multiplier, changed by the tool of the public player like the speed keys: the server sends
		// it to all clients, which change the speed at the same step (a client that joins resets it to normal)
		const bool on = arg_bool(a, "on", !fast_forward_on());
		const sint32 delta = (on ? NETWORK_FAST_FORWARD_MULTIPLIER : 16) - welt->get_time_multiplier();
		if (delta != 0) {
			tool_t *tool = create_tool(TOOL_CHANGE_GAME_SPEED | SIMPLE_TOOL);
			if (tool == NULL) {
				return "cannot change the speed";
			}
			char param[16];
			sprintf(param, "%d", (int)delta);
			tool->set_default_param(param);
			// sent by the server: no password check of the public player (like scenario scripts)
			tool->flags = tool_t::WFL_SCRIPT | tool_t::WFL_NO_CHK;
			bool suspended;
			welt->set_tool_api(tool, welt->get_public_player(), suspended);
			delete tool;
		}
		j.kv("fast_forward", on);
		j.kv("time_multiplier", (int)(on ? NETWORK_FAST_FORWARD_MULTIPLIER : 16));
		return NULL;
	}
	welt->set_fast_forward(arg_bool(a, "on", !welt->is_fast_forward()));
	j.kv("fast_forward", welt->is_fast_forward());
	return NULL;
}


static const char *cmd_zoom(const args_t &a, json_t &j)
{
	const std::string dir = arg_str(a, "dir", "in");
	if (dir != "in" && dir != "out") {
		return "dir must be in or out";
	}
	const int count = (int)clamp<sint64>(arg_int(a, "count", 1), 1, 10);
	for (int i = 0; i < count; i++) {
		win_change_zoom_factor(dir == "in");
	}
	j.kv("zoom_index", (int)gfx->get_zoom_factor());
	j.kv("tile_raster_width", (int)gfx->get_tile_raster_width());
	return NULL;
}


static const char *cmd_eval(const args_t &a, json_t &j)
{
	const std::string code = arg_str(a, "code");
	if (code.empty()) {
		return "missing code";
	}
	if (arg_bool(a, "reset", false)) {
		reset_eval_vm();
	}
	script_vm_t *script = get_eval_vm();
	if (script == NULL) {
		return "could not start the script engine (are the files in script/ present?)";
	}
	karte_t *welt = world();
	// unowned=1: act like a scenario script, i.e. tools may be used for any player,
	// even locked ones (e.g. to edit public infrastructure of a map); not in network games
	const bool unowned = arg_bool(a, "unowned", false);
	if (unowned  &&  env_t::networkmode) {
		return "unowned is not possible in network games";
	}
	script->set_my_player(unowned ? (uint8)PLAYER_UNOWNED : welt->get_active_player_nr());

	HSQUIRRELVM vm = script->get_vm();
	if (sq_getvmstate(vm) != SQ_VMSTATE_IDLE) {
		reset_eval_vm();
		return "script engine was busy and has been reset, please retry";
	}
	const SQInteger top = sq_gettop(vm);
	script_error.clear();

	// first try the code as an expression, then as a script body (which may use return)
	const std::string expr = "return (" + code + "\n);";
	if (!SQ_SUCCEEDED(sq_compilebuffer(vm, expr.c_str(), (SQInteger)expr.size(), "remote", SQFalse))) {
		script_error.clear();
		if (!SQ_SUCCEEDED(sq_compilebuffer(vm, code.c_str(), (SQInteger)code.size(), "remote", SQTrue))) {
			sq_settop(vm, top);
			if (script_error.empty()) {
				script_error = "compile error";
			}
			return script_error.c_str();
		}
	}

	const SQInteger ops = (SQInteger)clamp<sint64>(arg_int(a, "ops", 2000000), 1000, 200000000);
	sq_pushroottable(vm);
	const SQRESULT res = sq_call_restricted(vm, 1, SQTrue, SQTrue, ops);
	if (sq_getvmstate(vm) == SQ_VMSTATE_SUSPENDED) {
		reset_eval_vm();
		return "the script was suspended, which is not supported; the script engine has been reset";
	}
	if (SQ_FAILED(res)) {
		if (script_error.empty()) {
			sq_getlasterror(vm);
			const SQChar *s = NULL;
			if (SQ_SUCCEEDED(sq_tostring(vm, -1)) && SQ_SUCCEEDED(sq_getstring(vm, -1, &s)) && s) {
				script_error = s;
			}
			else {
				script_error = "script error";
			}
		}
		sq_settop(vm, top);
		return script_error.c_str();
	}
	j.key("result");
	write_sq_value(j, vm, -1, 0);
	sq_settop(vm, top);
	return NULL;
}


// ---------------------------------------------------------------------------
// game and map data as JSON
// ---------------------------------------------------------------------------

static double money(sint64 cents)
{
	return (double)cents / 100.0;
}


static char owner_char(sint8 nr)
{
	return (nr < 0 || nr >= MAX_PLAYER_COUNT) ? '.' : "0123456789abcdef"[nr & 15];
}


static char way_char(const weg_t *w)
{
	switch (w->get_waytype()) {
		case road_wt:        return 'R';
		case track_wt:       return w->get_desc()->get_styp() == type_tram ? 't' : '=';
		case water_wt:       return 'w';
		case monorail_wt:    return 'm';
		case maglev_wt:      return 'g';
		case narrowgauge_wt: return 'n';
		case air_wt:         return 'a';
		default:             return '+';
	}
}


/// one character describing what is visible on a tile from above, see the legend in tools/mcp
static char tile_char(const planquadrat_t *plan, sint8 &owner)
{
	const grund_t *gr = plan->get_kartenboden();
	owner = -1;

	// bridges and elevated ways above the ground are visible from above
	for (unsigned i = 0; i < plan->get_boden_count(); i++) {
		const grund_t *g = plan->get_boden_bei(i);
		if (g != gr && g->get_pos().z > gr->get_pos().z) {
			if (const weg_t *w = g->get_weg_nr(0)) {
				owner = owner_of(w->get_owner_nr());
			}
			if (g->get_typ() == grund_t::brueckenboden) {
				return 'B';
			}
			if (g->get_typ() == grund_t::monorailboden) {
				return 'E';
			}
		}
	}

	if (gr->is_halt()) {
		const halthandle_t halt = gr->get_halt();
		if (halt.is_bound() && halt->get_first_owner()) {
			owner = halt->get_first_owner()->get_player_nr();
		}
		return 'S';
	}
	if (const depot_t *dep = gr->get_depot()) {
		owner = owner_of(dep->get_owner_nr());
		return 'D';
	}
	if (gr->is_water()) {
		return '~';
	}
	if (const gebaeude_t *gb = gr->find<gebaeude_t>()) {
		owner = owner_of(gb->get_owner_nr());
		if (gb->get_fabrik()) {
			return 'F';
		}
		if (gb->is_townhall()) {
			return 'C';
		}
		if (gb->is_headquarter()) {
			return 'Q';
		}
		const building_desc_t *desc = gb->get_tile() ? gb->get_tile()->get_desc() : NULL;
		if (gb->is_monument() || (desc && desc->is_attraction())) {
			return 'A';
		}
		if (desc) {
			switch (desc->get_type()) {
				case building_desc_t::city_res: return 'h';
				case building_desc_t::city_com: return 'c';
				case building_desc_t::city_ind: return 'i';
				default: break;
			}
		}
		return 'b';
	}
	if (gr->ist_bruecke()) {
		if (const weg_t *w = gr->get_weg_nr(0)) {
			owner = owner_of(w->get_owner_nr());
		}
		return 'B';
	}
	if (gr->get_typ() == grund_t::tunnelboden) {
		if (const weg_t *w = gr->get_weg_nr(0)) {
			owner = owner_of(w->get_owner_nr());
		}
		return 'U';
	}
	if (gr->hat_wege()) {
		const weg_t *w = gr->get_weg_nr(0);
		owner = owner_of(w->get_owner_nr());
		return gr->has_two_ways() ? 'X' : way_char(w);
	}
	if (const obj_t *power = (const obj_t *)gr->get_leitung()) {
		owner = owner_of(power->get_owner_nr());
		return 'P';
	}
	char c = '.';
	for (uint8 n = 0; n < gr->obj_count(); n++) {
		switch (gr->obj_bei(n)->get_typ()) {
			case obj_t::field:     return 'f';
			case obj_t::baum:      c = 'T'; break;
			case obj_t::groundobj: if (c == '.') c = 'o'; break;
			default: break;
		}
	}
	return c;
}


static char slope_char(slope_t::type slope)
{
	if (slope == slope_t::flat) {
		return '.';
	}
	if (slope_t::is_way(slope)) {
		switch (ribi_type(slope)) {
			case ribi_t::north: return 'n';
			case ribi_t::south: return 's';
			case ribi_t::east:  return 'e';
			case ribi_t::west:  return 'w';
			default: break;
		}
	}
	return '*';
}


static void write_pos2(json_t &j, const char *k, koord pos)
{
	j.key(k).obj().kv("x", (int)pos.x).kv("y", (int)pos.y).end_obj();
}


static void write_halt_brief(json_t &j, halthandle_t halt)
{
	j.obj();
	j.kv("id", (int)halt.get_id());
	j.kv("name", halt->get_name());
	j.kv("owner", halt->get_first_owner() ? (int)halt->get_first_owner()->get_player_nr() : -1);
	write_koord3d(j, "pos", halt->get_basis_pos3d());
	j.kv("tiles", (uint32)halt->get_tiles().get_count());
	j.key("accepts").obj();
	j.kv("passengers", halt->get_pax_enabled());
	j.kv("mail", halt->get_mail_enabled());
	j.kv("goods", halt->get_ware_enabled());
	j.end_obj();
	j.key("waiting").obj();
	j.kv("total", (sint64)halt->get_finance_history(0, HALT_WAITING));
	j.kv("passengers", (sint64)halt->get_ware_summe(goods_manager_t::passengers));
	j.kv("mail", (sint64)halt->get_ware_summe(goods_manager_t::mail));
	j.end_obj();
	j.end_obj();
}


/// monthly statistics of a goods slot as [this month, last month], in the units of the factory window
static void write_goods_stat(json_t &j, const char *name, ware_production_t const &w, int stat)
{
	j.key(name).arr();
	j.num(w.get_stat_converted(0, stat));
	j.num(w.get_stat_converted(1, stat));
	j.end_arr();
}


/// "storage" and "max" of a goods slot are scaled like the factory window does (fabrik_t::info_prod)
static sint64 factory_slot_factor(const fabrik_t *fab, bool input, uint32 i)
{
	const factory_desc_t *desc = fab->get_desc();
	if (input  &&  desc->get_supplier(i)) {
		return desc->get_supplier(i)->get_consumption();
	}
	if (!input  &&  desc->get_product(i)) {
		return desc->get_product(i)->get_factor();
	}
	return DEFAULT_PRODUCTION_FACTOR;
}


/// the goods chart of the factory window per slot (gui/factory_chart.cc), defined below
static void write_factory_slot_history(json_t &j, ware_production_t const &w, bool input);


/// "inputs" and "outputs" of a factory; extras: more fields of the factory window, history: the goods chart of each slot
static void write_factory_slots(json_t &j, fabrik_t *fab, bool extras, bool history)
{
	for (int io = 0; io < 2; io++) {
		const bool input = io == 0;
		const array_tpl<ware_production_t> &slots = input ? fab->get_input() : fab->get_output();
		j.key(input ? "inputs" : "outputs").arr();
		for (uint32 i = 0; i < slots.get_count(); i++) {
			ware_production_t const &w = slots[i];
			const sint64 factor = factory_slot_factor(fab, input, i);
			const char *unit = w.get_typ() ? translator::translate(w.get_typ()->get_mass()) : "";
			while (*unit == ' ') {
				unit++;
			}
			j.obj();
			j.kv("goods", w.get_typ() ? translator::translate(w.get_typ()->get_name()) : "?");
			j.kv("unit", unit);
			j.kv("storage", convert_goods((sint64)w.menge * factor));
			j.kv("max", convert_goods((sint64)w.max * factor));
			if (input) {
				j.kv("in_transit", (sint64)w.get_in_transit());
				write_goods_stat(j, "received", w, FAB_GOODS_RECEIVED);
				write_goods_stat(j, "consumed", w, FAB_GOODS_CONSUMED);
			}
			else {
				write_goods_stat(j, "produced", w, FAB_GOODS_PRODUCED);
				write_goods_stat(j, "delivered", w, FAB_GOODS_DELIVERED);
			}
			if (extras) {
				// consumption/production per unit of production in % (the "%" of the factory window)
				j.kv("factor", convert_boost(factor));
				if (w.get_typ()) {
					j.kv("name", w.get_typ()->get_name());
					j.kv("category", translator::translate(w.get_typ()->get_catg_name()));
				}
				if (input  &&  world()->get_settings().get_just_in_time() < 2  &&  world()->get_settings().get_factory_maximum_intransit_percentage()) {
					j.kv("max_transit", (sint64)w.max_transit);
				}
				if (history) {
					write_factory_slot_history(j, w, input);
				}
			}
			j.end_obj();
		}
		j.end_arr();
	}
}


/// positions of the factories in a supplier or consumer list as [{"x","y"}] (the pos of the factory, as factories reports it)
static void write_factory_links(json_t &j, const char *key, const vector_tpl<koord> &list)
{
	j.key(key).arr();
	for (koord k : list) {
		if (const fabrik_t *other = fabrik_t::get_fab(k)) {
			j.obj().kv("x", (int)other->get_pos().x).kv("y", (int)other->get_pos().y).end_obj();
		}
	}
	j.end_arr();
}


/// the fields of an entry of factories; links: "suppliers" and "consumers" as positions instead of counts
static void write_factory_fields(json_t &j, fabrik_t *fab, bool details, bool links, bool extras, bool history)
{
	j.kv("name", translator::translate(fab->get_name()));
	j.kv("type", fab->get_desc()->get_name());
	write_koord3d(j, "pos", fab->get_pos());
	if (details) {
		j.kv("production", (sint64)fab->get_current_production());
		write_factory_slots(j, fab, extras, history);
	}
	if (links) {
		write_factory_links(j, "suppliers", fab->get_suppliers());
		write_factory_links(j, "consumers", fab->get_consumer());
	}
	else if (details) {
		j.kv("suppliers", (uint32)fab->get_suppliers().get_count());
		j.kv("consumers", (uint32)fab->get_consumer().get_count());
	}
}


static void write_factory_brief(json_t &j, fabrik_t *fab, bool details, bool links = false)
{
	j.obj();
	write_factory_fields(j, fab, details, links, false, false);
	j.end_obj();
}


/// convoi_t::states in order
static const char *const convoy_state_names[] = {
	"in_depot", "edit_schedule", "routing", "dummy4", "dummy5", "no_route", "driving", "loading",
	"waiting_for_clearance", "waiting_for_clearance_one_month", "can_start", "can_start_one_month",
	"self_destruct", "waiting_for_clearance_two_months", "can_start_two_months", "leaving_depot", "entering_depot"
};
static const int CONVOY_STATE_COUNT = (int)(sizeof(convoy_state_names) / sizeof(convoy_state_names[0]));


static const char *convoy_state_name(int state)
{
	return state >= 0 && state < CONVOY_STATE_COUNT ? convoy_state_names[state] : "unknown";
}


static void write_convoy_fields(json_t &j, convoihandle_t cnv, bool details)
{
	j.kv("id", (int)cnv.get_id());
	j.kv("name", cnv->get_name());
	j.kv("owner", cnv->get_owner() ? (int)cnv->get_owner()->get_player_nr() : -1);
	write_koord3d(j, "pos", cnv->get_pos());
	j.kv("state", convoy_state_name(cnv->get_state()));
	if (details) {
		j.kv("speed_kmh", (int)speed_to_kmh(cnv->get_akt_speed()));
		j.kv("max_speed_kmh", (int)speed_to_kmh(cnv->get_min_top_speed()));
		j.kv("vehicles", (int)cnv->get_vehicle_count());
		j.kv("loading_level", (int)cnv->get_loading_level());
		if (cnv->get_line().is_bound()) {
			j.key("line").obj().kv("id", (int)cnv->get_line().get_id()).kv("name", cnv->get_line()->get_name()).end_obj();
		}
		if (const schedule_t *schedule = cnv->get_schedule()) {
			if (!schedule->empty()) {
				write_koord3d(j, "next_stop", schedule->get_current_entry().pos);
			}
		}
		j.kv("profit_this_year", money(cnv->get_jahresgewinn()));
		j.kv("profit_last_month", money(cnv->get_finance_history(1, convoi_t::CONVOI_PROFIT)));
	}
}


static void write_convoy(json_t &j, convoihandle_t cnv, bool details)
{
	j.obj();
	write_convoy_fields(j, cnv, details);
	j.end_obj();
}


static bool owner_matches(const args_t &a, sint64 owner)
{
	return !has_arg(a, "owner") || arg_int(a, "owner", -1) == owner;
}


/// region from x,y,w,h or the visible part of the map around the view center
static void get_region(const args_t &a, koord &lo, koord &size, bool &truncated)
{
	karte_t *welt = world();
	const sint64 max_size = clamp<sint64>(arg_int(a, "max_size", 96), 4, 512);
	truncated = false;
	if (has_arg(a, "x") && has_arg(a, "y")) {
		lo = koord((sint16)arg_int(a, "x", 0), (sint16)arg_int(a, "y", 0));
		size = koord((sint16)arg_int(a, "w", 32), (sint16)arg_int(a, "h", arg_int(a, "w", 32)));
	}
	else {
		// in the isometric view (x-y) spans width/raster and (x+y) spans 2*height/raster tiles
		const scr_size screen = gfx->get_screen_size();
		const sint64 raster = max(1, (int)gfx->get_tile_raster_width());
		const sint64 half = (screen.w / raster + (2 * screen.h) / raster) / 2 + 1;
		const koord center = welt->get_viewport()->get_world_position();
		lo = koord((sint16)(center.x - half), (sint16)(center.y - half));
		size = koord((sint16)(2 * half + 1), (sint16)(2 * half + 1));
	}
	if (size.x > max_size || size.y > max_size) {
		// keep the center
		const koord center = lo + size / 2;
		size = koord((sint16)(size.x > max_size ? max_size : size.x), (sint16)(size.y > max_size ? max_size : size.y));
		lo = center - size / 2;
		truncated = true;
	}
	// clip to the map
	koord hi = lo + size;
	lo.clip_min(koord(0, 0));
	hi.clip_max(welt->get_size());
	size = hi - lo;
	if (size.x < 0) size.x = 0;
	if (size.y < 0) size.y = 0;
}


static const char *cmd_map(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	koord lo, size;
	bool truncated;
	get_region(a, lo, size, truncated);
	if (size.x <= 0 || size.y <= 0) {
		return "region is outside of the map";
	}
	const std::string layers = "," + arg_str(a, "layers", "terrain,height") + ",";
	const bool want_terrain = layers.find(",terrain,") != std::string::npos;
	const bool want_height  = layers.find(",height,") != std::string::npos;
	const bool want_owner   = layers.find(",owner,") != std::string::npos;
	const bool want_slope   = layers.find(",slope,") != std::string::npos;
	const bool want_features = arg_bool(a, "features", true);

	j.key("region").obj().kv("x", (int)lo.x).kv("y", (int)lo.y).kv("w", (int)size.x).kv("h", (int)size.y).end_obj();
	j.kv("truncated", truncated);
	j.kv("groundwater", (int)welt->get_groundwater());

	// one pass over the region: only the requested layers, row after row in one buffer per layer
	const size_t w = (size_t)size.x;
	const size_t tiles = w * (size_t)size.y;
	const bool want_tile_char = want_terrain  ||  want_owner;
	std::string terrain(want_terrain ? tiles : 0, ' ');
	std::string owner(want_owner ? tiles : 0, ' ');
	std::string slope(want_slope ? tiles : 0, ' ');
	std::vector<sint8> heights(tiles);

	// objects found in the region, in the order of their first tile; ids/pointers seen before are skipped
	vector_tpl<halthandle_t> halts;
	vector_tpl<fabrik_t *> factories;
	vector_tpl<convoihandle_t> convoys;
	vector_tpl<const grund_t *> labels, depots;
	std::vector<bool> halt_seen, convoy_seen;
	std::unordered_set<const fabrik_t *> factory_seen;
	if (want_features) {
		halt_seen.resize(65536);
		convoy_seen.resize(65536);
	}

	size_t i = 0;
	for (sint16 y = lo.y; y < lo.y + size.y; y++) {
		for (sint16 x = lo.x; x < lo.x + size.x; x++, i++) {
			const planquadrat_t *plan = welt->access(x, y);
			const grund_t *gr = plan->get_kartenboden();
			heights[i] = gr->get_pos().z;
			if (want_tile_char) {
				sint8 own;
				const char c = tile_char(plan, own);
				if (want_terrain) {
					terrain[i] = c;
				}
				if (want_owner) {
					owner[i] = owner_char(own);
				}
			}
			if (want_slope) {
				slope[i] = slope_char(gr->get_grund_hang());
			}

			if (want_features) {
				for (unsigned b = 0; b < plan->get_boden_count(); b++) {
					const grund_t *g = plan->get_boden_bei(b);
					if (g->is_halt()) {
						const halthandle_t halt = g->get_halt();
						if (halt.is_bound()  &&  !halt_seen[halt.get_id()]) {
							halt_seen[halt.get_id()] = true;
							halts.append(halt);
						}
					}
					for (uint8 n = 0; n < g->obj_count(); n++) {
						obj_t *obj = g->obj_bei(n);
						switch (obj->get_typ()) {
							case obj_t::gebaeude:
								if (fabrik_t *fab = static_cast<gebaeude_t *>(obj)->get_fabrik()) {
									if (factory_seen.insert(fab).second) {
										factories.append(fab);
									}
								}
								break;
							case obj_t::road_vehicle:
							case obj_t::rail_vehicle:
							case obj_t::monorail_vehicle:
							case obj_t::maglev_vehicle:
							case obj_t::narrowgauge_vehicle:
							case obj_t::water_vehicle:
							case obj_t::air_vehicle:
								if (const convoi_t *cnv = static_cast<vehicle_t *>(obj)->get_convoi()) {
									const convoihandle_t self = cnv->self;
									if (!convoy_seen[self.get_id()]) {
										convoy_seen[self.get_id()] = true;
										convoys.append(self);
									}
								}
								break;
							default:
								break;
						}
					}
				}
				// labels (map markers) and depots on the surface
				if (gr->find<label_t>()) {
					labels.append(gr);
				}
				if (gr->get_depot()) {
					depots.append(gr);
				}
			}
		}
	}

	const sint8 zmin = *std::min_element(heights.begin(), heights.end());
	j.key("height_base").num(zmin);

	if (want_terrain) {
		j.key("terrain").arr();
		for (size_t r = 0; r < tiles; r += w) {
			j.safe_str(terrain.data() + r, w);
		}
		j.end_arr();
	}
	if (want_height) {
		static const char height_digits[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
		std::string row(w, ' ');
		j.key("height").arr();
		for (size_t r = 0; r < tiles; r += w) {
			for (size_t x = 0; x < w; x++) {
				row[x] = height_digits[clamp(heights[r + x] - zmin, 0, 61)];
			}
			j.safe_str(row.data(), w);
		}
		j.end_arr();
	}
	if (want_owner) {
		j.key("owner").arr();
		for (size_t r = 0; r < tiles; r += w) {
			j.safe_str(owner.data() + r, w);
		}
		j.end_arr();
	}
	if (want_slope) {
		j.key("slope").arr();
		for (size_t r = 0; r < tiles; r += w) {
			j.safe_str(slope.data() + r, w);
		}
		j.end_arr();
	}

	if (want_features) {
		const koord hi = lo + size;
		j.key("cities").arr();
		for (stadt_t *city : welt->get_cities()) {
			const koord p = city->get_pos();
			if (p.x >= lo.x && p.y >= lo.y && p.x < hi.x && p.y < hi.y) {
				j.obj();
				j.kv("name", city->get_name());
				write_pos2(j, "townhall", p);
				j.kv("citizens", (sint64)city->get_einwohner());
				j.end_obj();
			}
		}
		j.end_arr();

		j.key("stations").arr();
		for (halthandle_t halt : halts) {
			write_halt_brief(j, halt);
		}
		j.end_arr();

		j.key("factories").arr();
		for (fabrik_t *fab : factories) {
			write_factory_brief(j, fab, false);
		}
		j.end_arr();

		j.key("convoys").arr();
		for (convoihandle_t cnv : convoys) {
			if (cnv.is_bound()) {
				write_convoy(j, cnv, false);
			}
		}
		j.end_arr();

		j.key("labels").arr();
		for (const grund_t *gr : labels) {
			j.obj();
			write_koord3d(j, "pos", gr->get_pos());
			j.kv("text", gr->get_text());
			j.end_obj();
		}
		j.end_arr();
		j.key("depots").arr();
		for (const grund_t *gr : depots) {
			const depot_t *dep = gr->get_depot();
			j.obj();
			write_koord3d(j, "pos", gr->get_pos());
			j.kv("type", obj_type_name(dep->get_typ()));
			j.kv("owner", owner_of(dep->get_owner_nr()));
			j.end_obj();
		}
		j.end_arr();
	}
	return NULL;
}


static void write_finance_month(json_t &j, const char *k, finance_t *f, int month)
{
	j.key(k).obj();
	j.kv("revenue", money(f->get_history_veh_month(TT_ALL, month, ATV_REVENUE)));
	j.kv("running_costs", money(f->get_history_veh_month(TT_ALL, month, ATV_RUNNING_COST)));
	j.kv("infrastructure_maintenance", money(f->get_history_veh_month(TT_ALL, month, ATV_INFRASTRUCTURE_MAINTENANCE)));
	j.kv("operating_profit", money(f->get_history_veh_month(TT_ALL, month, ATV_OPERATING_PROFIT)));
	j.kv("construction", money(f->get_history_veh_month(TT_ALL, month, ATV_CONSTRUCTION_COST)));
	j.kv("new_vehicles", money(f->get_history_veh_month(TT_ALL, month, ATV_NEW_VEHICLE)));
	j.kv("profit", money(f->get_history_veh_month(TT_ALL, month, ATV_PROFIT)));
	j.kv("transported_passengers", (sint64)f->get_history_veh_month(TT_ALL, month, ATV_TRANSPORTED_PASSENGER));
	j.kv("transported_mail", (sint64)f->get_history_veh_month(TT_ALL, month, ATV_TRANSPORTED_MAIL));
	j.kv("transported_goods", (sint64)f->get_history_veh_month(TT_ALL, month, ATV_TRANSPORTED_GOOD));
	j.end_obj();
}


/**
 * Changes the bank account of a player by amount (in credits, may be negative).
 * Like book_cash() of scenario scripts this runs TOOL_CHANGE_PLAYER as the public player,
 * so it also works in network games (through the server).
 */
static const char *cmd_cash(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const sint64 nr = arg_int(a, "player", welt->get_active_player_nr());
	player_t *player = (nr >= 0  &&  nr < MAX_PLAYER_COUNT) ? welt->get_player((uint8)nr) : NULL;
	if (player == NULL) {
		return "no such player";
	}
	const std::string amount_str = arg_str(a, "amount");
	char *end = NULL;
	const double amount = strtod(amount_str.c_str(), &end);
	if (amount_str.empty()  ||  end == amount_str.c_str()  ||  *end != 0  ||  !std::isfinite(amount)) {
		return "amount must be a number (credits)";
	}
	if (std::fabs(amount) > 1e9) {
		return "amount must be between -1000000000 and 1000000000";
	}
	const sint64 cents = (sint64)std::llround(amount * 100.0);
	if (cents == 0) {
		return "amount must not be 0";
	}

	const sint64 before = player->get_finance()->get_account_balance();
	// the tool takes a 32 bit amount in 1/100 credits: book larger amounts in steps of 20 million
	const sint64 step_max = 2000000000;
	tool_t *tool = tool_t::simple_tool[TOOL_CHANGE_PLAYER];
	int steps = 0;
	for (sint64 rest = cents; rest != 0; steps++) {
		const sint64 step = rest > step_max ? step_max : (rest < -step_max ? -step_max : rest);
		cbuffer_t param;
		param.printf("$,%d,%d", (int)nr, (int)step);
		tool->set_default_param(param);
		welt->set_tool(tool, welt->get_public_player());
		tool->set_default_param(NULL);
		rest -= step;
	}
	const sint64 after = player->get_finance()->get_account_balance();

	j.kv("player", (int)nr);
	j.kv("name", player->get_name());
	j.kv("amount", money(cents));
	j.kv("cash_before", money(before));
	j.kv("cash", money(after));
	j.kv("steps", steps);
	if (after == before) {
		// network game: booked when the server executes the tool; otherwise refused (e.g. by the scenario)
		j.kv("pending", true);
	}
	return NULL;
}


/// names of the general tools in the script API (tool_ids in script/api/api_const.cc)
static const struct { const char *name; uint16 tool; } script_tool_names[] = {
	{ "tool_remover",             TOOL_REMOVER },
	{ "tool_raise_land",          TOOL_RAISE_LAND },
	{ "tool_lower_land",          TOOL_LOWER_LAND },
	{ "tool_setslope",            TOOL_SETSLOPE },
	{ "tool_restoreslope",        TOOL_RESTORESLOPE },
	{ "tool_set_marker",          TOOL_MARKER },
	{ "tool_clear_reservation",   TOOL_CLEAR_RESERVATION },
	{ "tool_build_transformer",   TOOL_TRANSFORMER },
	{ "tool_add_city",            TOOL_ADD_CITY },
	{ "tool_change_city_size",    TOOL_CHANGE_CITY_SIZE },
	{ "tool_plant_tree",          TOOL_PLANT_TREE },
	{ "tool_build_groundobj",     TOOL_PLANT_GROUNDOBJ },
	{ "tool_build_way",           TOOL_BUILD_WAY },
	{ "tool_build_bridge",        TOOL_BUILD_BRIDGE },
	{ "tool_build_tunnel",        TOOL_BUILD_TUNNEL },
	{ "tool_remove_way",          TOOL_WAYREMOVER },
	{ "tool_build_wayobj",        TOOL_BUILD_WAYOBJ },
	{ "tool_build_station",       TOOL_BUILD_STATION },
	{ "tool_build_roadsign",      TOOL_BUILD_ROADSIGN },
	{ "tool_build_depot",         TOOL_BUILD_DEPOT },
	{ "tool_build_house",         TOOL_BUILD_HOUSE },
	{ "tool_land_chain",          TOOL_BUILD_LAND_CHAIN },
	{ "tool_city_chain",          TOOL_CITY_CHAIN },
	{ "tool_build_factory",       TOOL_BUILD_FACTORY },
	{ "tool_link_factory",        TOOL_LINK_FACTORY },
	{ "tool_headquarter",         TOOL_HEADQUARTER },
	{ "tool_lock_game",           TOOL_LOCK_GAME },
	{ "tool_add_citycar",         TOOL_ADD_CITYCAR },
	{ "tool_forest",              TOOL_FOREST },
	{ "tool_stop_mover",          TOOL_STOP_MOVER },
	{ "tool_make_stop_public",    TOOL_MAKE_STOP_PUBLIC },
	{ "tool_remove_wayobj",       TOOL_REMOVE_WAYOBJ },
	{ "tool_buy_house",           TOOL_BUY_HOUSE },
	{ "tool_build_cityroad",      TOOL_BUILD_CITYROAD },
	{ "tool_change_water_height", TOOL_CHANGE_WATER_HEIGHT },
	{ "tool_set_climate",         TOOL_SET_CLIMATE },
	{ "tool_rotate_building",     TOOL_ROTATE_BUILDING },
	{ "tool_merge_stop",          TOOL_MERGE_STOP },
	{ "tool_set_owner",           TOOL_SET_OWNER }
};


static bool parse_tool_ref(std::string s, uint16 &id);


/// tool=<script name like tool_build_way | engine name like TOOL_BUILD_WAY | general_tool[14] | number>
static const char *parse_work_tool(const std::string &s, uint16 &id)
{
	if (s.empty()) {
		return "missing tool";
	}
	if (isdigit((unsigned char)s[0])) {
		// numeric id including the GENERAL_TOOL flag (0x1000), decimal or 0x hex, as in scripts
		char *end = NULL;
		const unsigned long v = strtoul(s.c_str(), &end, 0);
		if (*end != 0  ||  v > 0xFFFF) {
			return make_error("unknown tool '%s'", s.c_str());
		}
		id = (uint16)v;
	}
	else {
		std::string lower = s;
		std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return (char)tolower(c); });
		bool found = false;
		for (auto const &t : script_tool_names) {
			if (lower == t.name) {
				id = (uint16)(t.tool | GENERAL_TOOL);
				found = true;
				break;
			}
		}
		if (!found  &&  !parse_tool_ref(s, id)) {
			return make_error("unknown tool '%s': use a name like tool_build_way or TOOL_BUILD_WAY or a numeric id", s.c_str());
		}
	}
	if ((id & 0xF000) != GENERAL_TOOL  ||  (id & 0x0FFF) >= GENERAL_TOOL_COUNT) {
		// like command_x of scripts: no dialogs, no simple tools (quit, save, ...), no toolbars
		return make_error("tool '%s' cannot be used here: only build and remove tools (general tools) work at map positions", s.c_str());
	}
	const uint16 nr = id & 0x0FFF;
	if (nr == TOOL_EXEC_SCRIPT  ||  nr == TOOL_EXEC_TWO_CLICK_SCRIPT) {
		return "scripted tools cannot be used through the remote control";
	}
	return NULL;
}


/**
 * Applies a build/remove tool at map positions like command_x.work() of the script API does:
 * tool=<name or id> x,y[,z] [x2,y2[,z2]] [param=<default parameter>] [player=<nr>] [ctrl=1] [shift=1].
 * The player defaults to the active player; players protected by a password are refused.
 * Single player: {"result":null} or an error. Network game: the tool goes through the server
 * like a click ({"pending":true}), its result is shown in the game.
 */
static const char *cmd_tool(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	uint16 id = 0;
	if (const char *err = parse_work_tool(arg_str(a, "tool"), id)) {
		return err;
	}
	const sint64 nr = arg_int(a, "player", welt->get_active_player_nr());
	player_t *player = (nr >= 0  &&  nr < PLAYER_UNOWNED) ? welt->get_player((uint8)nr) : NULL;
	if (player == NULL) {
		return "no such player";
	}
	if (player->is_locked()) {
		// never bypass passwords: the player must be unlocked in the game first
		return make_error("player %s is protected by a password; unlock it in the game first", player->get_name());
	}
	koord3d start, end = koord3d::invalid;
	if (const char *err = get_tile_pos(a, start)) {
		return err;
	}
	const bool twoclick = has_arg(a, "x2")  ||  has_arg(a, "y2");
	if (twoclick) {
		if (const char *err = get_tile_pos(a, end, "x2", "y2", "z2")) {
			return err;
		}
	}

	std::unique_ptr<tool_t> tool(create_tool(id));
	if (!tool) {
		return "could not create this tool";
	}
	// the tool keeps a pointer to its parameter, which must live until the tool is deleted
	const bool has_param = has_arg(a, "param");
	const std::string param = arg_str(a, "param");
	tool->set_default_param(has_param ? param.c_str() : NULL);
	tool->flags = tool_t::WFL_SCRIPT;
	if (arg_bool(a, "ctrl", false)) {
		tool->flags |= tool_t::WFL_CTRL;
	}
	if (arg_bool(a, "shift", false)) {
		tool->flags |= tool_t::WFL_SHIFT;
	}
	tool->callback_id = 0;

	// the same checks as script_api::param<call_tool_work>::push (script/api/api_command.cc)
	const uint8 flags = tool->flags; // init() may reset them
	if (!tool->is_init_keeps_game_state()) {
		return "Initializing tool has side effects";
	}
	if (!tool->init(player)) {
		return "Error during initializing tool";
	}
	tool->flags = flags;
	if (tool->is_work_keeps_game_state()  ||  (!twoclick  &&  tool->is_work_here_keeps_game_state(player, start))) {
		return "Tool has no effects (it cannot work at this position, or it needs a second position x2,y2)";
	}
	if (twoclick) {
		if (dynamic_cast<two_click_tool_t *>(tool.get()) == NULL) {
			return "Cannot call this tool with two coordinates";
		}
		if (!tool->is_work_here_keeps_game_state(player, start)) {
			return "First click has side effects";
		}
	}

	bool suspended = false;
	const char *err = NULL;
	if (twoclick) {
		// first click: only sets the start (checked above), never sent to the server
		err = welt->call_work_api(tool.get(), player, start, suspended);
	}
	if (err == NULL) {
		// network game: sent to the server as a copy (nwc_tool_t), so the tool can be deleted afterwards
		err = welt->call_work_api(tool.get(), player, twoclick ? end : start, suspended);
	}
	if (err) {
		// copied, the text may belong to the tool, which is deleted on return
		return *err ? make_error("%s", err) : "the tool did not work here (no reason given)";
	}
	if (suspended) {
		j.kv("pending", true);
	}
	else {
		j.key("result").null();
	}
	return NULL;
}


static const char *cmd_players(const args_t &, json_t &j)
{
	karte_t *welt = world();
	int convoys[MAX_PLAYER_COUNT] = {};
	int stations[MAX_PLAYER_COUNT] = {};
	for (convoihandle_t cnv : welt->convoys()) {
		if (cnv.is_bound() && cnv->get_owner()) {
			convoys[cnv->get_owner()->get_player_nr()]++;
		}
	}
	for (halthandle_t halt : haltestelle_t::get_alle_haltestellen()) {
		if (halt.is_bound() && halt->get_first_owner()) {
			stations[halt->get_first_owner()->get_player_nr()]++;
		}
	}
	j.kv("active_player", (int)welt->get_active_player_nr());
	j.key("players").arr();
	for (int i = 0; i < MAX_PLAYER_COUNT; i++) {
		player_t *player = welt->get_player(i);
		if (player == NULL) {
			continue;
		}
		// the sums of the running month (revenue, profit, all transport types) are only updated by
		// calc_finance_history(): compute them in a copy like cmd_finance does
		std::unique_ptr<finance_t> copy(new finance_t(*player->get_finance()));
		copy->calc_finance_history();
		finance_t *f = copy.get();
		j.obj();
		j.kv("nr", i);
		j.kv("name", player->get_name());
		j.kv("type", player->get_ai_id() == player_t::HUMAN ? (i == 1 ? "public" : "human") : "ai");
		j.kv("active", player->is_active());
		j.kv("locked", player->is_locked());
		j.kv("cash", money(f->get_account_balance()));
		j.kv("net_wealth", money(f->get_netwealth()));
		const koord hq = player->get_headquarter_pos();
		if (hq != koord::invalid) {
			write_pos2(j, "headquarter", hq);
		}
		j.kv("lines", (uint32)player->simlinemgmt.get_line_list().get_count());
		j.kv("convoys", convoys[i]);
		j.kv("stations", stations[i]);
		write_finance_month(j, "this_month", f, 0);
		write_finance_month(j, "last_month", f, 1);
		j.end_obj();
	}
	j.end_arr();
	return NULL;
}


/**
 * Paging of the object lists: offset=N skips the first N objects (after the filters),
 * limit=N returns at most N (0 = all), fields=summary only the main fields.
 */
struct page_t
{
	sint64 offset;
	sint64 limit;   ///< 0 = no limit
	sint64 total;   ///< objects that passed the filters so far
	bool summary;

	page_t(const args_t &a, sint64 default_limit)
	{
		offset = arg_int(a, "offset", 0);
		if (offset < 0) {
			offset = 0;
		}
		limit = arg_int(a, "limit", default_limit);
		if (limit < 0) {
			limit = 0;
		}
		total = 0;
		summary = arg_str(a, "fields") == "summary";
	}

	/// counts an object that passed the filters, true if it is on the requested page
	bool take()
	{
		const sint64 i = total++;
		return i >= offset  &&  (limit == 0  ||  i - offset < limit);
	}

	void write(json_t &j) const
	{
		j.kv("total", total);
		j.kv("offset", offset);
		j.kv("truncated", limit > 0  &&  total - offset > limit);
	}
};


/**
 * The fields of an entry of cities. "id" is the index of the city in the city list of the world
 * (the index the game itself uses to rename a city): cities are saved and loaded in this order,
 * so the id stays the same across save/load and network joins; it changes only for the cities
 * after a removed city (new cities are appended).
 */
static void write_city_fields(json_t &j, stadt_t *city, uint32 id, bool summary)
{
	j.kv("id", id);
	j.kv("name", city->get_name());
	write_pos2(j, "townhall", city->get_pos());
	if (summary) {
		j.kv("citizens", (sint64)city->get_einwohner());
		return;
	}
	j.key("area").obj();
	j.kv("x1", (int)city->get_linksoben().x).kv("y1", (int)city->get_linksoben().y);
	j.kv("x2", (int)city->get_rechtsunten().x).kv("y2", (int)city->get_rechtsunten().y);
	j.end_obj();
	j.kv("citizens", (sint64)city->get_einwohner());
	j.kv("growth_this_month", city->get_finance_history_month(0, HIST_GROWTH));
	j.kv("buildings", city->get_finance_history_month(0, HIST_BUILDING));
	// last complete month
	j.key("last_month").obj();
	j.kv("passengers_generated", city->get_finance_history_month(1, HIST_PAS_GENERATED));
	j.kv("passengers_transported", city->get_finance_history_month(1, HIST_PAS_TRANSPORTED));
	j.kv("passengers_walked", city->get_finance_history_month(1, HIST_PAS_WALKED));
	j.kv("mail_generated", city->get_finance_history_month(1, HIST_MAIL_GENERATED));
	j.kv("mail_transported", city->get_finance_history_month(1, HIST_MAIL_TRANSPORTED));
	j.kv("goods_supplied", city->get_finance_history_month(1, HIST_GOODS_RECEIVED));
	j.kv("goods_needed", city->get_finance_history_month(1, HIST_GOODS_NEEDED));
	j.end_obj();
}


static const char *cmd_cities(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	// sorted by citizens, each with its index in the city list (its id)
	std::vector<std::pair<stadt_t *, uint32>> cities;
	cities.reserve(welt->get_cities().get_count());
	for (uint32 i = 0; i < welt->get_cities().get_count(); i++) {
		cities.push_back(std::make_pair(welt->get_cities()[i], i));
	}
	std::stable_sort(cities.begin(), cities.end(), [](const std::pair<stadt_t *, uint32> &a, const std::pair<stadt_t *, uint32> &b) {
		return a.first->get_einwohner() > b.first->get_einwohner();
	});
	page_t page(a, 100);
	j.kv("count", (uint32)cities.size());
	j.key("cities").arr();
	for (std::pair<stadt_t *, uint32> const &c : cities) {
		if (!page.take()) {
			continue;
		}
		j.obj();
		write_city_fields(j, c.first, c.second, page.summary);
		j.end_obj();
	}
	j.end_arr();
	page.write(j);
	return NULL;
}


static const char *cmd_stations(const args_t &a, json_t &j)
{
	page_t page(a, 200);
	j.key("stations").arr();
	for (halthandle_t halt : haltestelle_t::get_alle_haltestellen()) {
		if (!halt.is_bound()) {
			continue;
		}
		const int owner = halt->get_first_owner() ? halt->get_first_owner()->get_player_nr() : -1;
		if (!owner_matches(a, owner)  ||  !page.take()) {
			continue;
		}
		if (page.summary) {
			j.obj();
			j.kv("id", (int)halt.get_id());
			j.kv("name", halt->get_name());
			j.kv("owner", owner);
			write_koord3d(j, "pos", halt->get_basis_pos3d());
			j.end_obj();
		}
		else {
			write_halt_brief(j, halt);
		}
	}
	j.end_arr();
	page.write(j);
	return NULL;
}


static const char *cmd_convoys(const args_t &a, json_t &j)
{
	page_t page(a, 200);
	j.key("convoys").arr();
	for (convoihandle_t cnv : world()->convoys()) {
		if (!cnv.is_bound()) {
			continue;
		}
		const int owner = cnv->get_owner() ? cnv->get_owner()->get_player_nr() : -1;
		if (!owner_matches(a, owner)  ||  !page.take()) {
			continue;
		}
		if (page.summary) {
			j.obj();
			j.kv("id", (int)cnv.get_id());
			j.kv("name", cnv->get_name());
			j.kv("owner", owner);
			write_koord3d(j, "pos", cnv->get_pos());
			j.kv("line", cnv->get_line().is_bound() ? (int)cnv->get_line().get_id() : 0);
			j.kv("state", convoy_state_name(cnv->get_state()));
			j.end_obj();
		}
		else {
			write_convoy(j, cnv, true);
		}
	}
	j.end_arr();
	page.write(j);
	return NULL;
}


/// "this_month" and "last_month" of a line (the lines command and the line command)
static void write_line_months(json_t &j, linehandle_t line)
{
	for (int m = 0; m < 2; m++) {
		j.key(m == 0 ? "this_month" : "last_month").obj();
		j.kv("profit", money(line->get_finance_history(m, LINE_PROFIT)));
		j.kv("revenue", money(line->get_finance_history(m, LINE_REVENUE)));
		j.kv("transported", (sint64)line->get_finance_history(m, LINE_TRANSPORTED_GOODS));
		j.kv("capacity", (sint64)line->get_finance_history(m, LINE_CAPACITY));
		j.end_obj();
	}
}


static const char *cmd_lines(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	page_t page(a, 200);
	j.key("lines").arr();
	for (int i = 0; i < MAX_PLAYER_COUNT; i++) {
		player_t *player = welt->get_player(i);
		if (player == NULL || !owner_matches(a, i)) {
			continue;
		}
		for (linehandle_t line : player->simlinemgmt.get_line_list()) {
			if (!line.is_bound()  ||  !page.take()) {
				continue;
			}
			j.obj();
			j.kv("id", (int)line.get_id());
			j.kv("name", line->get_name());
			j.kv("owner", i);
			if (page.summary) {
				j.kv("convoys", line->count_convoys());
				j.end_obj();
				continue;
			}
			j.kv("type", simline_t::get_linetype_name(line->get_linetype()));
			j.kv("convoys", line->count_convoys());
			j.key("stops").arr();
			if (const schedule_t *schedule = line->get_schedule()) {
				for (schedule_entry_t const &e : schedule->entries) {
					j.obj();
					write_koord3d(j, "pos", e.pos);
					const halthandle_t halt = haltestelle_t::get_halt(e.pos, player);
					if (halt.is_bound()) {
						j.kv("station", halt->get_name());
					}
					j.end_obj();
				}
			}
			j.end_arr();
			write_line_months(j, line);
			j.end_obj();
		}
	}
	j.end_arr();
	page.write(j);
	return NULL;
}


// ---------------------------------------------------------------------------
// details and histories of single objects: finance, line, convoy, station, route
// (only reads, values converted like the game windows show them)
// ---------------------------------------------------------------------------

/// handle of an object id, unbound for ids out of range (quickstone_tpl::set_id() does not check)
template<class T> static quickstone_tpl<T> handle_of(sint64 id)
{
	quickstone_tpl<T> h;
	if (id > 0  &&  id < (sint64)quickstone_tpl<T>::get_size()) {
		h.set_id((uint16)id);
	}
	return h;
}


/// translated unit of a goods type without leading spaces
static const char *goods_unit(const goods_desc_t *g)
{
	const char *unit = translator::translate(g->get_mass());
	while (*unit == ' ') {
		unit++;
	}
	return unit;
}


/// name of a goods category as the game shows it: special freight by its name, else the category name
static const char *goods_catg_name(uint8 catg_index)
{
	const goods_desc_t *info = goods_manager_t::get_info_catg_index(catg_index);
	if (info == NULL) {
		return "?";
	}
	return translator::translate(info->get_catg() == 0 ? info->get_name() : info->get_catg_name());
}


/// a column of a monthly statistic: index into the history array, money (1/100 credits, sent as credits)
struct stat_column_t
{
	const char *name;
	int index;
	bool money;
};

/**
 * "<key>":{"columns":[names],"rows":[[values] x months]} with row 0 = the running month, then older,
 * get(month, index) returns the raw value
 */
template<class F>
static void write_stat_table(json_t &j, const char *key, const stat_column_t *cols, size_t ncols, int months, F get)
{
	j.key(key).obj();
	j.key("columns").arr();
	for (size_t c = 0; c < ncols; c++) {
		j.str(cols[c].name);
	}
	j.end_arr();
	j.key("rows").arr();
	for (int m = 0; m < months; m++) {
		j.arr();
		for (size_t c = 0; c < ncols; c++) {
			const sint64 v = get(m, cols[c].index);
			if (cols[c].money) {
				j.dbl(money(v));
			}
			else {
				j.num(v);
			}
		}
		j.end_arr();
	}
	j.end_arr();
	j.end_obj();
}

/// the chart of the line window (gui/line_management_gui.cc), in its order
static const stat_column_t line_stat_columns[] = {
	{ "free_capacity", LINE_CAPACITY,          false },
	{ "transported",   LINE_TRANSPORTED_GOODS, false },
	{ "revenue",       LINE_REVENUE,           true },
	{ "operation",     LINE_OPERATIONS,        true },
	{ "toll",          LINE_WAYTOLL,           true },
	{ "profit",        LINE_PROFIT,            true },
	{ "convoys",       LINE_CONVOIS,           false },
	{ "distance",      LINE_DISTANCE,          false },
	{ "max_speed",     LINE_MAXSPEED,          false }
};

/// the chart of the convoy window (gui/convoi_info.cc)
static const stat_column_t convoy_stat_columns[] = {
	{ "free_capacity", convoi_t::CONVOI_CAPACITY,          false },
	{ "transported",   convoi_t::CONVOI_TRANSPORTED_GOODS, false },
	{ "revenue",       convoi_t::CONVOI_REVENUE,           true },
	{ "operation",     convoi_t::CONVOI_OPERATIONS,        true },
	{ "profit",        convoi_t::CONVOI_PROFIT,            true },
	{ "distance",      convoi_t::CONVOI_DISTANCE,          false },
	{ "max_speed",     convoi_t::CONVOI_MAXSPEED,          false },
	{ "toll",          convoi_t::CONVOI_WAYTOLL,           true }
};

/// the chart of the station window (gui/halt_info.cc)
static const stat_column_t halt_stat_columns[] = {
	{ "happy",    HALT_HAPPY,           false },
	{ "unhappy",  HALT_UNHAPPY,         false },
	{ "no_route", HALT_NOROUTE,         false },
	{ "waiting",  HALT_WAITING,         false },
	{ "arrived",  HALT_ARRIVED,         false },
	{ "departed", HALT_DEPARTED,        false },
	{ "convoys",  HALT_CONVOIS_ARRIVED, false },
	{ "walked",   HALT_WALKED,          false }
};


/// transport types of the finance window (finance_t::transport_type_values)
static const char *const finance_tt_names[TT_MAX] = {
	"all", "road", "rail", "ship", "monorail", "maglev", "tram", "narrowgauge", "air", "other", "powerline"
};

/// a column of the finance window (gui/money_frame.cc)
struct finance_column_t
{
	const char *name;
	uint8 type;   ///< accounting_type_vehicles, or accounting_type_common if common
	bool common;  ///< company wide value (the same for every transport type)
	uint8 unit;   ///< 0 number, 1 money (1/100 credits, sent as credits), 2 percent (1/100 %, sent as %)
};

static const finance_column_t finance_columns[] = {
	{ "transported",      ATV_TRANSPORTED,                false, 0 },
	{ "delivered",        ATV_DELIVERED,                  false, 0 },
	{ "revenue",          ATV_REVENUE,                    false, 1 },
	{ "running_costs",    ATV_RUNNING_COST,               false, 1 },
	{ "maintenance",      ATV_INFRASTRUCTURE_MAINTENANCE, false, 1 },
	{ "toll",             ATV_WAY_TOLL,                   false, 1 },
	{ "operating_profit", ATV_OPERATING_PROFIT,           false, 1 },
	{ "new_vehicles",     ATV_NEW_VEHICLE,                false, 1 },
	{ "construction",     ATV_CONSTRUCTION_COST,          false, 1 },
	{ "profit",           ATV_PROFIT,                     false, 1 },
	{ "cash",             ATC_CASH,                       true,  1 },
	{ "assets",           ATV_NON_FINANCIAL_ASSETS,       false, 1 },
	{ "margin",           ATV_PROFIT_MARGIN,              false, 2 },
	{ "net_wealth",       ATC_NETWEALTH,                  true,  1 }
};


static sint64 finance_value(const finance_t *f, int tt, finance_column_t const &c, int row, bool monthly)
{
	if (c.common) {
		return monthly ? f->get_history_com_month(row, c.type) : f->get_history_com_year(row, c.type);
	}
	return monthly ? f->get_history_veh_month((transport_type)tt, row, c.type) : f->get_history_veh_year((transport_type)tt, row, c.type);
}


/// like money_frame_t::is_chart_table_zero(): the finance window lists only transport types with data
static bool finance_tt_used(const finance_t *f, int tt)
{
	if (f->get_maintenance_with_bits((transport_type)tt) != 0) {
		return true;
	}
	for (finance_column_t const &c : finance_columns) {
		if (c.common  &&  tt != TT_ALL) {
			continue;
		}
		for (int r = 0; r < MAX_PLAYER_HISTORY_MONTHS; r++) {
			if (finance_value(f, tt, c, r, true) != 0) {
				return true;
			}
		}
		for (int r = 0; r < MAX_PLAYER_HISTORY_YEARS; r++) {
			if (finance_value(f, tt, c, r, false) != 0) {
				return true;
			}
		}
	}
	return false;
}


/// rows of the finance history, row 0 = running month/year; empty rows from before the game started are left out
static void write_finance_rows(json_t &j, const char *key, const finance_t *f, int tt, bool monthly, int game_rows)
{
	const int max_rows = monthly ? MAX_PLAYER_HISTORY_MONTHS : MAX_PLAYER_HISTORY_YEARS;
	int rows = clamp(game_rows, 1, max_rows);
	for (int r = max_rows - 1; r >= rows; r--) {
		bool used = false;
		for (finance_column_t const &c : finance_columns) {
			if (finance_value(f, tt, c, r, monthly) != 0) {
				used = true;
				break;
			}
		}
		if (used) {
			rows = r + 1;
			break;
		}
	}
	j.key(key).arr();
	for (int r = 0; r < rows; r++) {
		j.arr();
		for (finance_column_t const &c : finance_columns) {
			const sint64 v = finance_value(f, tt, c, r, monthly);
			if (c.unit == 0) {
				j.num(v);
			}
			else {
				j.dbl((double)v / 100.0);
			}
		}
		j.end_arr();
	}
	j.end_arr();
}


static const char *cmd_finance(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const sint64 nr = arg_int(a, "player", welt->get_active_player_nr());
	player_t *player = (nr >= 0  &&  nr < MAX_PLAYER_COUNT) ? welt->get_player((uint8)nr) : NULL;
	if (player == NULL) {
		return "no such player";
	}
	const std::string tt_arg = arg_str(a, "tt", "all");
	int tt = -1;
	for (int i = 0; i < TT_MAX; i++) {
		if (tt_arg == finance_tt_names[i]) {
			tt = i;
		}
	}
	if (tt < 0) {
		return "tt must be one of all road rail ship monorail maglev tram narrowgauge air other powerline";
	}
	const std::string period = arg_str(a, "period", "both");
	if (period != "month"  &&  period != "year"  &&  period != "both") {
		return "period must be month, year or both";
	}

	// The sums of the running month and year (revenue, profit, margin, cash, net wealth, ...) are only
	// updated by finance_t::calc_finance_history(), which the finance window calls when it draws.
	// Compute them in a copy, so that this command changes no data of the game (network games).
	std::unique_ptr<finance_t> f(new finance_t(*player->get_finance()));
	f->calc_finance_history();

	const settings_t &s = welt->get_settings();
	const sint64 start = (sint64)s.get_starting_year() * 12 + s.get_starting_month();
	const sint64 months = (sint64)welt->get_current_month() - start + 1;
	const sint64 years = (sint64)welt->get_current_month() / 12 - s.get_starting_year() + 1;

	j.kv("player", (int)nr);
	j.kv("name", player->get_name());
	j.kv("tt", finance_tt_names[tt]);
	write_date(j, "date", welt->get_current_month());
	j.key("columns").arr();
	for (finance_column_t const &c : finance_columns) {
		j.str(c.name);
	}
	j.end_arr();
	if (period != "year") {
		write_finance_rows(j, "month", f.get(), tt, true, (int)clamp<sint64>(months, 1, MAX_PLAYER_HISTORY_MONTHS));
	}
	if (period != "month") {
		write_finance_rows(j, "year", f.get(), tt, false, (int)clamp<sint64>(years, 1, MAX_PLAYER_HISTORY_YEARS));
	}
	// maintenance per month as the finance window shows it (negative = costs)
	j.kv("maintenance_per_month", money(-f->get_maintenance_with_bits((transport_type)tt)));
	j.kv("overdrawn_months", (int)f->get_account_overdrawn());
	j.key("tt_list").arr();
	for (int i = 0; i < TT_MAX; i++) {
		if (finance_tt_used(f.get(), i)) {
			j.str(finance_tt_names[i]);
		}
	}
	j.end_arr();
	return NULL;
}


/// goods types of the goods categories of a line
static void get_line_goods(linehandle_t line, vector_tpl<const goods_desc_t *> &goods)
{
	const minivec_tpl<uint8> &catgs = line->get_goods_catg_index();
	for (uint16 i = 0; i < goods_manager_t::get_count(); i++) {
		const goods_desc_t *g = goods_manager_t::get_info(i);
		if (g != goods_manager_t::none  &&  catgs.is_contained(g->get_catg_index())) {
			goods.append(g);
		}
	}
}


/**
 * The entries of a schedule: position, halt id (null for a depot or waypoint) and name, loading rules;
 * with goods also the amount of these goods waiting at the halt (all destinations).
 */
static void write_schedule_entries(json_t &j, const schedule_t *schedule, const player_t *owner, const vector_tpl<const goods_desc_t *> *goods)
{
	const bool water = schedule->get_waytype() == water_wt;
	j.arr();
	for (schedule_entry_t const &e : schedule->entries) {
		j.obj();
		write_koord3d(j, "pos", e.pos);
		const halthandle_t halt = haltestelle_t::get_halt(e.pos, owner, water);
		if (halt.is_bound()) {
			j.kv("halt", (int)halt.get_id());
			j.kv("name", halt->get_name());
		}
		else {
			// like schedule_t::gimme_stop_name()
			const grund_t *gr = world()->lookup(e.pos);
			const bool depot = gr  &&  gr->get_depot();
			j.key("halt").null();
			j.kv("name", translator::translate(gr == NULL ? "Invalid coordinate" : (depot ? "Depot" : "Wegpunkt")));
			if (depot) {
				j.kv("depot", true);
			}
		}
		if (e.get_absolute_departures()) {
			j.kv("departures_per_month", (int)e.get_absolute_departures());
			j.kv("departure_ticks", e.get_waiting_ticks());
		}
		else {
			j.kv("wait_for_load", (int)e.minimum_loading);
			if (e.minimum_loading > 0  &&  e.waiting_time > 0) {
				j.kv("max_wait_ticks", e.get_waiting_ticks());
			}
		}
		if (goods  &&  halt.is_bound()) {
			sint64 waiting = 0;
			for (const goods_desc_t *g : *goods) {
				if (halt->gibt_ab(g)) {
					waiting += halt->get_ware_summe(g);
				}
			}
			j.kv("waiting", waiting);
		}
		j.end_obj();
	}
	j.end_arr();
}


static const char *cmd_line(const args_t &a, json_t &j)
{
	const linehandle_t line = handle_of<simline_t>(arg_int(a, "id", 0));
	if (!line.is_bound()) {
		return "no line with this id";
	}
	player_t *owner = line->get_owner();
	j.key("line").obj();
	j.kv("id", (int)line.get_id());
	j.kv("name", line->get_name());
	j.kv("owner", owner ? (int)owner->get_player_nr() : -1);
	j.kv("type", simline_t::get_linetype_name(line->get_linetype()));
	j.kv("convoys", line->count_convoys());
	j.kv("withdraw", line->get_withdraw());
	write_line_months(j, line);
	j.end_obj();

	j.key("goods").arr();
	for (uint8 catg : line->get_goods_catg_index()) {
		j.str(goods_catg_name(catg));
	}
	j.end_arr();

	// convoys, and their capacity and load now (as the line window shows them)
	sint64 capacity = 0, load = 0;
	j.key("convoys").arr();
	for (convoihandle_t cnv : line->get_convoys()) {
		if (!cnv.is_bound()) {
			continue;
		}
		j.num(cnv.get_id());
		for (uint16 i = 0; i < cnv->get_vehicle_count(); i++) {
			capacity += cnv->get_vehicle(i)->get_cargo_max();
			load += cnv->get_vehicle(i)->get_total_cargo();
		}
	}
	j.end_arr();
	j.kv("capacity", capacity);
	j.kv("load", load);

	j.key("schedule");
	if (const schedule_t *schedule = line->get_schedule()) {
		vector_tpl<const goods_desc_t *> goods;
		get_line_goods(line, goods);
		write_schedule_entries(j, schedule, owner, &goods);
	}
	else {
		j.arr().end_arr();
	}

	if (arg_bool(a, "history", false)) {
		write_stat_table(j, "history", line_stat_columns, lengthof(line_stat_columns), MAX_MONTHS,
			[&](int m, int t) { return line->get_finance_history(m, t); });
	}
	return NULL;
}


static const char *cmd_convoy(const args_t &a, json_t &j)
{
	const convoihandle_t cnv = handle_of<convoi_t>(arg_int(a, "id", 0));
	if (!cnv.is_bound()) {
		return "no convoy with this id";
	}
	karte_t *welt = world();
	const player_t *owner = cnv->get_owner();

	// the convoy window and its details tab
	j.key("convoy").obj();
	write_convoy_fields(j, cnv, true);
	j.kv("power_kw", (sint64)cnv->get_sum_power());
	j.kv("weight_t", (double)cnv->get_sum_gesamtweight() / 1000.0);
	j.kv("empty_weight_t", (double)cnv->get_sum_weight() / 1000.0);
	j.kv("running_cost_per_km", money(cnv->get_running_cost()));
	j.kv("value", money(cnv->calc_restwert()));
	j.kv("odometer_km", (sint64)cnv->get_total_distance_traveled());
	j.kv("speedbonus_kmh", (int)cnv->get_speedbonus_kmh());
	j.kv("loading_limit", (int)cnv->get_loading_limit());
	j.kv("length_tiles", cnv->get_vehicle_count() > 0 ? (int)cnv->get_tile_length() : 0);
	j.kv("withdraw", cnv->get_withdraw());
	j.kv("no_load", cnv->get_no_load());
	write_koord3d(j, "home_depot", cnv->get_home_depot());
	if (cnv->get_vehicle_count() > 0) {
		j.key("route").obj();
		j.kv("index", (int)cnv->front()->get_route_index());
		j.kv("length", (uint32)cnv->get_route()->get_count());
		j.end_obj();
	}
	j.end_obj();

	const sint32 month_now = (sint32)welt->get_current_month();
	const uint16 timeline = welt->get_timeline_year_month();
	j.key("vehicles").arr();
	for (uint16 i = 0; i < cnv->get_vehicle_count(); i++) {
		const vehicle_t *v = cnv->get_vehicle(i);
		const vehicle_desc_t *desc = v->get_desc();
		j.obj();
		j.kv("name", translator::translate(desc->get_name()));
		write_date(j, "built", (uint32)max(0, v->get_purchase_time()));
		j.kv("age_months", (int)(month_now - v->get_purchase_time()));
		j.kv("value", money(v->calc_sale_value()));
		j.kv("capacity", (int)v->get_cargo_max());
		j.kv("load", (int)v->get_total_cargo());
		if (v->get_cargo_max() > 0  &&  v->get_cargo_type()) {
			const goods_desc_t *g = v->get_cargo_type();
			j.kv("goods", translator::translate(g->get_catg() == 0 ? g->get_name() : g->get_catg_name()));
			j.kv("unit", goods_unit(g));
		}
		j.kv("speed_kmh", (int)desc->get_topspeed());
		j.kv("power_kw", (sint64)desc->get_power());
		j.kv("weight_t", (double)v->get_total_weight() / 1000.0);
		j.kv("running_cost_per_km", money(desc->get_running_cost()));
		j.kv("fixed_cost_per_month", money(welt->scale_with_month_length(desc->get_maintenance())));
		j.kv("retired", welt->use_timeline()  &&  desc->is_retired(timeline));
		j.end_obj();
	}
	j.end_arr();

	if (const schedule_t *schedule = cnv->get_schedule()) {
		j.key("schedule").obj();
		j.kv("current", (int)schedule->get_current_stop());
		j.key("entries");
		write_schedule_entries(j, schedule, owner, NULL);
		j.end_obj();
	}

	// the loaded freight, joined like the freight list of the convoy window (same goods, destination and next stop)
	struct freight_t
	{
		ware_t ware;
		uint32 amount;
	};
	std::vector<freight_t> freight;
	for (uint16 i = 0; i < cnv->get_vehicle_count(); i++) {
		for (ware_t const &w : cnv->get_vehicle(i)->get_cargo()) {
			bool joined = false;
			for (freight_t &f : freight) {
				if (f.ware.same_destination(w)  &&  f.ware.get_via_halt() == w.get_via_halt()) {
					f.amount += w.amount;
					joined = true;
					break;
				}
			}
			if (!joined) {
				freight.push_back({ w, (uint32)w.amount });
			}
		}
	}
	std::stable_sort(freight.begin(), freight.end(), [](const freight_t &x, const freight_t &y) { return x.amount > y.amount; });
	j.key("freight").arr();
	for (freight_t const &f : freight) {
		const halthandle_t target = f.ware.get_target_halt();
		const halthandle_t via = f.ware.get_via_halt();
		j.obj();
		j.kv("goods", translator::translate(f.ware.get_name()));
		j.kv("amount", f.amount);
		j.kv("unit", goods_unit(f.ware.get_desc()));
		if (target.is_bound()) {
			j.kv("destination", target->get_name());
			j.kv("destination_id", (int)target.get_id());
		}
		else {
			j.key("destination").null();
		}
		if (via.is_bound()  &&  via != target) {
			j.kv("via", via->get_name());
			j.kv("via_id", (int)via.get_id());
		}
		if (f.ware.to_factory) {
			if (const fabrik_t *fab = fabrik_t::get_fab(f.ware.get_target_pos())) {
				j.kv("factory", translator::translate(fab->get_name()));
			}
		}
		j.end_obj();
	}
	j.end_arr();

	if (arg_bool(a, "history", false)) {
		write_stat_table(j, "history", convoy_stat_columns, lengthof(convoy_stat_columns), MAX_MONTHS,
			[&](int m, int t) { return cnv->get_finance_history(m, t); });
	}
	return NULL;
}


/// true if the convoy drives on a route now (not in a depot, not without route)
static bool convoy_has_route(convoihandle_t cnv)
{
	if (!cnv.is_bound()  ||  cnv->get_vehicle_count() == 0) {
		return false;
	}
	switch (cnv->get_state()) {
		case convoi_t::INITIAL:
		case convoi_t::EDIT_SCHEDULE:
		case convoi_t::ROUTING_1:
		case convoi_t::NO_ROUTE:
		case convoi_t::SELF_DESTRUCT:
			return false;
		default:
			return cnv->get_route()->get_count() >= 2;
	}
}


/// "<key>":{"halt":id|null,"name":..,"pos":[x,y]} for an end of a route
static void write_route_end(json_t &j, const char *key, koord3d pos, const player_t *owner)
{
	const halthandle_t halt = haltestelle_t::get_halt(pos, owner);
	j.key(key).obj();
	if (halt.is_bound()) {
		j.kv("halt", (int)halt.get_id());
		j.kv("name", halt->get_name());
	}
	else {
		j.key("halt").null();
	}
	j.key("pos").arr().num(pos.x).num(pos.y).end_arr();
	j.end_obj();
}


/// the route of a convoy (the leg to its next stop) as polyline with only the corners, [x,y] per point
static void write_convoy_route(json_t &j, convoihandle_t cnv)
{
	const route_t *route = cnv->get_route();
	std::vector<koord> pts;
	for (uint32 i = 0; i < route->get_count(); i++) {
		const koord p = route->at((uint16)i).get_2d();
		if (!pts.empty()  &&  pts.back() == p) {
			continue; // same square on another height (ramps, bridges)
		}
		if (pts.size() >= 2) {
			const koord a = pts[pts.size() - 2], b = pts.back();
			const sint32 dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = p.x - b.x, dy2 = p.y - b.y;
			if (dx1 * dy2 - dy1 * dx2 == 0  &&  dx1 * dx2 + dy1 * dy2 > 0) {
				pts.back() = p; // straight on
				continue;
			}
		}
		pts.push_back(p);
	}
	j.kv("convoy", (int)cnv.get_id());
	j.kv("leg", true);
	write_route_end(j, "from", route->front(), cnv->get_owner());
	write_route_end(j, "to", route->back(), cnv->get_owner());
	j.kv("length", (sint64)route->get_count() - 1);
	j.kv("index", (int)cnv->front()->get_route_index());
	j.key("points").arr();
	for (koord const &p : pts) {
		j.arr().num(p.x).num(p.y).end_arr();
	}
	j.end_arr();
}


/**
 * line_route id=<line> [all=1] | convoy=<id>: the route a convoy drives now. Convoys only know the route
 * of the leg to their next stop, so all=1 returns the different legs of all convoys of a line.
 */
static const char *cmd_line_route(const args_t &a, json_t &j)
{
	if (has_arg(a, "convoy")) {
		const convoihandle_t cnv = handle_of<convoi_t>(arg_int(a, "convoy", 0));
		if (!cnv.is_bound()) {
			return "no convoy with this id";
		}
		if (!convoy_has_route(cnv)) {
			j.kv("convoy", (int)cnv.get_id());
			j.kv("state", convoy_state_name(cnv->get_state()));
			j.key("points").arr().end_arr();
			j.kv("reason", "the convoy has no route now");
			return NULL;
		}
		write_convoy_route(j, cnv);
		return NULL;
	}
	const linehandle_t line = handle_of<simline_t>(arg_int(a, "id", 0));
	if (!line.is_bound()) {
		return "no line with this id";
	}
	j.kv("line", (int)line.get_id());
	if (!arg_bool(a, "all", false)) {
		for (convoihandle_t cnv : line->get_convoys()) {
			if (convoy_has_route(cnv)) {
				write_convoy_route(j, cnv);
				return NULL;
			}
		}
		j.key("convoy").null();
		j.key("points").arr().end_arr();
		j.kv("reason", "no convoy of the line has a route now");
		return NULL;
	}
	// one leg per different start and end (halt, or square for waypoints and depots)
	const player_t *owner = line->get_owner();
	std::vector<std::pair<koord3d, koord3d> > seen;
	std::vector<koord3d> targets;
	auto end_key = [&](koord3d pos) {
		const halthandle_t halt = haltestelle_t::get_halt(pos, owner);
		return halt.is_bound() ? halt->get_basis_pos3d() : pos;
	};
	j.key("legs").arr();
	for (convoihandle_t cnv : line->get_convoys()) {
		if (!convoy_has_route(cnv)) {
			continue;
		}
		const route_t *route = cnv->get_route();
		const std::pair<koord3d, koord3d> leg(end_key(route->front()), end_key(route->back()));
		if (std::find(seen.begin(), seen.end(), leg) != seen.end()) {
			continue;
		}
		seen.push_back(leg);
		targets.push_back(leg.second);
		j.obj();
		write_convoy_route(j, cnv);
		j.end_obj();
	}
	j.end_arr();
	// schedule entries that are the end of a leg
	int stops = 0, covered = 0;
	if (const schedule_t *schedule = line->get_schedule()) {
		for (schedule_entry_t const &e : schedule->entries) {
			stops++;
			if (std::find(targets.begin(), targets.end(), end_key(e.pos)) != targets.end()) {
				covered++;
			}
		}
	}
	j.kv("stops", stops);
	j.kv("covered", covered);
	return NULL;
}


/// waiting goods of a halt per goods type (only types with something waiting)
static void write_halt_waiting_goods(json_t &j, halthandle_t halt)
{
	j.key("waiting_by_goods").arr();
	for (uint16 i = 0; i < goods_manager_t::get_count(); i++) {
		const goods_desc_t *g = goods_manager_t::get_info(i);
		if (g == goods_manager_t::none  ||  !halt->gibt_ab(g)) {
			continue;
		}
		const uint32 amount = halt->get_ware_summe(g);
		if (amount == 0) {
			continue;
		}
		j.obj();
		j.kv("goods", translator::translate(g->get_name()));
		j.kv("amount", amount);
		j.kv("unit", goods_unit(g));
		// the storage class of haltestelle_t::get_capacity()
		j.kv("class", i == goods_manager_t::INDEX_PAS ? "passengers" : (i == goods_manager_t::INDEX_MAIL ? "mail" : "goods"));
		j.end_obj();
	}
	j.end_arr();
}


/// waiting goods of a halt per next stop (the halt where they leave the next convoy) and goods type
static void write_halt_waiting_next(json_t &j, halthandle_t halt)
{
	struct row_t
	{
		halthandle_t next;
		const goods_desc_t *goods;
		uint32 amount;
	};
	std::vector<row_t> rows;
	uint64 total = 0, assigned = 0;
	for (uint16 i = 0; i < goods_manager_t::get_count(); i++) {
		const goods_desc_t *g = goods_manager_t::get_info(i);
		if (g == goods_manager_t::none  ||  !halt->gibt_ab(g)) {
			continue;
		}
		const uint32 sum = halt->get_ware_summe(g);
		if (sum == 0) {
			continue;
		}
		total += sum;
		for (haltestelle_t::connection_t const &c : halt->get_connections(g->get_catg_index())) {
			if (!c.halt.is_bound()) {
				continue;
			}
			const uint32 amount = halt->get_ware_fuer_zwischenziel(g, c.halt);
			if (amount > 0) {
				rows.push_back({ c.halt, g, amount });
				assigned += amount;
			}
		}
	}
	std::stable_sort(rows.begin(), rows.end(), [](const row_t &x, const row_t &y) { return x.amount > y.amount; });
	j.key("waiting_by_next").arr();
	for (row_t const &r : rows) {
		j.obj();
		j.kv("halt", (int)r.next.get_id());
		j.kv("name", r.next->get_name());
		j.kv("goods", translator::translate(r.goods->get_name()));
		j.kv("amount", r.amount);
		j.end_obj();
	}
	j.end_arr();
	// goods routed to a halt that is no direct connection any more
	j.kv("waiting_other", (sint64)(total - assigned));
}


/// estimated ticks until a convoy arrives at its next stop, like gui_departure_board_t::calc_ticks_until_arrival()
static uint32 ticks_until_arrival(convoihandle_t cnv)
{
	uint32 delta_t = 0;
	sint32 delta_tiles = (sint32)cnv->get_route()->get_count() - (sint32)cnv->front()->get_route_index();
	const uint32 kmh_average = (cnv->get_average_kmh() * 900) / 1024u;
	// braking on the last tiles
	if (delta_tiles > 1  &&  kmh_average > 25) {
		delta_tiles--;
		delta_t += 3276;
	}
	if (delta_tiles > 1  &&  kmh_average > 50) {
		delta_tiles--;
		delta_t += 1638;
	}
	if (delta_tiles > 1  &&  kmh_average > 100) {
		delta_tiles--;
		delta_t += 819;
	}
	if (cnv->get_state() != convoi_t::DRIVING) {
		// waiting at a signal: time for acceleration
		delta_t += kmh_average * 25;
	}
	if (delta_tiles > 0) {
		const sint64 speed = std::max<sint64>(1, kmh_to_speed((sint64)kmh_average));
		delta_t += (uint32)(((sint64)delta_tiles << (8 + 12)) / speed);
	}
	return delta_t;
}


/**
 * Next departures from and arrivals at a halt, computed like the departure board of the station
 * window (gui/halt_info.cc, without its smoothing of the arrival times over several updates).
 */
static void write_departures(json_t &j, halthandle_t halt, size_t max_rows)
{
	struct entry_t
	{
		convoihandle_t cnv;
		halthandle_t halt; ///< next stop (departures) or previous stop (arrivals)
		sint64 ticks;      ///< from now
	};
	karte_t *welt = world();
	const uint32 now = welt->get_ticks();
	std::vector<entry_t> departures, arrivals;

	// convoys loading here
	for (convoihandle_t cnv : halt->get_loading_convois()) {
		if (!cnv.is_bound()  ||  cnv->get_state() != convoi_t::LOADING  ||  !cnv->get_schedule()  ||  cnv->get_vehicle_count() == 0) {
			continue;
		}
		const halthandle_t next = cnv->get_schedule()->get_next_halt(cnv->get_owner(), halt);
		if (!next.is_bound()) {
			continue;
		}
		const schedule_entry_t &e = cnv->get_schedule()->get_current_entry();
		uint32 t = 0;
		if (e.get_absolute_departures()) {
			t = cnv->get_departure_ticks();
		}
		else if (e.waiting_time > 0) {
			t = cnv->get_arrival_ticks() + e.get_waiting_ticks();
		}
		departures.push_back({ cnv, next, t > now ? (sint64)(t - now) : 0 });
		if (const grund_t *gr = welt->lookup(cnv->front()->last_stop_pos)) {
			if (gr->get_halt().is_bound()  &&  gr->get_halt() != halt) {
				arrivals.push_back({ cnv, gr->get_halt(), 0 });
			}
		}
	}

	// convoys on their way here
	auto on_the_way = [&](convoihandle_t cnv) {
		if (!cnv.is_bound()  ||  !cnv->get_schedule()  ||  cnv->get_vehicle_count() == 0) {
			return;
		}
		if (cnv->get_state() != convoi_t::DRIVING  &&  !cnv->is_waiting()) {
			return;
		}
		const schedule_t *schedule = cnv->get_schedule();
		if (haltestelle_t::get_halt(schedule->get_current_entry().pos, cnv->get_owner()) != halt) {
			return;
		}
		const sint64 t = ticks_until_arrival(cnv);
		const halthandle_t prev = haltestelle_t::get_halt(cnv->front()->last_stop_pos, cnv->get_owner());
		if (prev.is_bound()) {
			arrivals.push_back({ cnv, prev, t });
		}
		const halthandle_t next = schedule->get_next_halt(cnv->get_owner(), halt);
		if (next.is_bound()) {
			const schedule_entry_t &e = schedule->get_current_entry();
			sint64 d = t;
			if (e.get_absolute_departures()) {
				d = (sint64)cnv->get_departure_ticks(now + (uint32)t) - now;
			}
			else if (e.waiting_time > 0) {
				d += e.get_waiting_ticks();
			}
			else {
				d += 2000;
			}
			departures.push_back({ cnv, next, d + 2000 });
		}
	};
	for (linehandle_t line : halt->registered_lines) {
		if (line.is_bound()) {
			for (convoihandle_t cnv : line->get_convoys()) {
				on_the_way(cnv);
			}
		}
	}
	for (convoihandle_t cnv : halt->registered_convoys) {
		on_the_way(cnv);
	}

	auto write_list = [&](const char *key, std::vector<entry_t> &list) {
		std::stable_sort(list.begin(), list.end(), [](const entry_t &x, const entry_t &y) { return x.ticks < y.ticks; });
		j.key(key).arr();
		for (size_t i = 0; i < list.size()  &&  i < max_rows; i++) {
			entry_t const &e = list[i];
			j.obj();
			j.kv("convoy", (int)e.cnv.get_id());
			j.kv("line", e.cnv->get_line().is_bound() ? (int)e.cnv->get_line().get_id() : 0);
			j.kv("halt", (int)e.halt.get_id());
			j.kv("name", e.halt->get_name());
			j.kv("ticks", e.ticks);
			// the text of the departure board, e.g. "+2 13:00h"
			const char *time = e.ticks <= 0 ? translator::translate("now") : difftick_to_string((sint32)e.ticks, true);
			while (*time == ' ') {
				time++;
			}
			j.kv("time", time);
			j.end_obj();
		}
		j.end_arr();
	};
	write_list("departures", departures);
	write_list("arrivals", arrivals);
	j.kv("ticks_per_month", (sint64)welt->ticks_per_world_month);
}


static const char *cmd_station(const args_t &a, json_t &j)
{
	halthandle_t halt;
	if (has_arg(a, "id")) {
		halt = handle_of<haltestelle_t>(arg_int(a, "id", 0));
	}
	else if (has_arg(a, "x") && has_arg(a, "y")) {
		// the stop on a ground of the square (any level); get_halt_koord_index is only for loading old games: its
		// table is gone after loading (crash) and it would create a halt
		const koord k((sint16)arg_int(a, "x", 0), (sint16)arg_int(a, "y", 0));
		if (const planquadrat_t *plan = world()->access(k)) {
			for (uint8 b = 0; b < plan->get_boden_count()  &&  !halt.is_bound(); b++) {
				const grund_t *g = plan->get_boden_bei(b);
				if (g->is_halt()) {
					halt = g->get_halt();
				}
			}
		}
	}
	if (!halt.is_bound()) {
		return "no station with this id / at this position";
	}
	const std::string waiting = arg_str(a, "waiting");
	if (!waiting.empty()  &&  waiting.find("goods") == std::string::npos  &&  waiting.find("next") == std::string::npos) {
		return "waiting must be goods, next or goods,next";
	}
	j.key("station");
	write_halt_brief(j, halt);
	j.key("this_month").obj();
	j.kv("happy", halt->get_pax_happy());
	j.kv("unhappy", halt->get_pax_unhappy());
	j.kv("no_route", halt->get_pax_no_route());
	j.kv("arrived", (sint64)halt->get_finance_history(0, HALT_ARRIVED));
	j.kv("departed", (sint64)halt->get_finance_history(0, HALT_DEPARTED));
	j.kv("convoys_arrived", (sint64)halt->get_finance_history(0, HALT_CONVOIS_ARRIVED));
	j.end_obj();
	j.key("last_month").obj();
	j.kv("happy", (sint64)halt->get_finance_history(1, HALT_HAPPY));
	j.kv("unhappy", (sint64)halt->get_finance_history(1, HALT_UNHAPPY));
	j.kv("no_route", (sint64)halt->get_finance_history(1, HALT_NOROUTE));
	j.kv("arrived", (sint64)halt->get_finance_history(1, HALT_ARRIVED));
	j.kv("departed", (sint64)halt->get_finance_history(1, HALT_DEPARTED));
	j.kv("convoys_arrived", (sint64)halt->get_finance_history(1, HALT_CONVOIS_ARRIVED));
	j.end_obj();
	j.key("tiles").arr();
	for (haltestelle_t::tile_t const &t : halt->get_tiles()) {
		j.obj();
		write_koord3d(j, "pos", t.grund->get_pos());
		j.end_obj();
	}
	j.end_arr();

	// storage capacity as the station window shows it (one shared value unless the halt capacities are separate)
	j.key("capacity").obj();
	j.kv("passengers", halt->get_capacity(0));
	j.kv("mail", halt->get_capacity(1));
	j.kv("goods", halt->get_capacity(2));
	j.kv("separate", world()->get_settings().is_separate_halt_capacities());
	j.end_obj();

	if (arg_bool(a, "history", false)) {
		write_stat_table(j, "history", halt_stat_columns, lengthof(halt_stat_columns), MAX_MONTHS,
			[&](int m, int t) { return halt->get_finance_history(m, t); });
	}
	if (waiting.find("goods") != std::string::npos) {
		write_halt_waiting_goods(j, halt);
	}
	if (waiting.find("next") != std::string::npos) {
		write_halt_waiting_next(j, halt);
	}
	if (arg_bool(a, "lines", false)) {
		j.key("lines").arr();
		for (linehandle_t line : halt->registered_lines) {
			if (!line.is_bound()) {
				continue;
			}
			j.obj();
			j.kv("id", (int)line.get_id());
			j.kv("name", line->get_name());
			j.kv("owner", line->get_owner() ? (int)line->get_owner()->get_player_nr() : -1);
			j.kv("type", simline_t::get_linetype_name(line->get_linetype()));
			j.end_obj();
		}
		j.end_arr();
		j.key("lineless_convoys").arr();
		for (convoihandle_t cnv : halt->registered_convoys) {
			if (!cnv.is_bound()) {
				continue;
			}
			j.obj();
			j.kv("id", (int)cnv.get_id());
			j.kv("name", cnv->get_name());
			j.kv("owner", cnv->get_owner() ? (int)cnv->get_owner()->get_player_nr() : -1);
			j.end_obj();
		}
		j.end_arr();
	}
	const sint64 departures = arg_int(a, "departures", 0);
	if (departures > 0) {
		write_departures(j, halt, (size_t)std::min<sint64>(departures, 100));
	}
	return NULL;
}


/// optional region x1,y1,x2,y2 (inclusive) of the commands factories and positions
struct region_filter_t
{
	bool active;
	sint64 x1, y1, x2, y2;

	explicit region_filter_t(const args_t &a)
	{
		active = has_arg(a, "x1") && has_arg(a, "y1") && has_arg(a, "x2") && has_arg(a, "y2");
		x1 = arg_int(a, "x1", 0);
		y1 = arg_int(a, "y1", 0);
		x2 = arg_int(a, "x2", 0);
		y2 = arg_int(a, "y2", 0);
	}

	bool contains(koord3d p) const
	{
		return !active  ||  (p.x >= x1  &&  p.x <= x2  &&  p.y >= y1  &&  p.y <= y2);
	}
};


static const char *cmd_factories(const args_t &a, json_t &j)
{
	page_t page(a, 200);
	const region_filter_t region(a);
	const bool links = arg_bool(a, "links", false);
	j.kv("count", (uint32)world()->get_fab_list().get_count());
	j.key("factories").arr();
	for (fabrik_t *fab : world()->get_fab_list()) {
		if (!region.contains(fab->get_pos())  ||  !page.take()) {
			continue;
		}
		write_factory_brief(j, fab, !page.summary, links);
	}
	j.end_arr();
	page.write(j);
	return NULL;
}


// ---------------------------------------------------------------------------
// details and histories of cities, factories, supply chains, goods and the world
// (only reads, values converted like the game windows show them)
// ---------------------------------------------------------------------------

/// the chart of the city window (gui/city_info.cc) in its order; the unused electricity entry is left out
static const stat_column_t city_stat_columns[] = {
	{ "citizens",               HIST_CITIZENS,         false },
	{ "growth",                 HIST_GROWTH,           false },
	{ "buildings",              HIST_BUILDING,         false },
	{ "citycars",               HIST_CITYCARS,         false },
	{ "passengers_transported", HIST_PAS_TRANSPORTED,  false },
	{ "passengers_walked",      HIST_PAS_WALKED,       false },
	{ "passengers_generated",   HIST_PAS_GENERATED,    false },
	{ "mail_transported",       HIST_MAIL_TRANSPORTED, false },
	{ "mail_walked",            HIST_MAIL_WALKED,      false },
	{ "mail_generated",         HIST_MAIL_GENERATED,   false },
	{ "goods_supplied",         HIST_GOODS_RECEIVED,   false },
	{ "goods_needed",           HIST_GOODS_NEEDED,     false }
};


static bool equal_nocase(const char *a, const char *b)
{
	while (*a  &&  tolower((unsigned char)*a) == tolower((unsigned char)*b)) {
		a++;
		b++;
	}
	return *a == 0  &&  *b == 0;
}


/// city by id= (index in the city list), name= or x= y= (the city whose area contains the square)
static const char *find_city(const args_t &a, stadt_t *&city, uint32 &id)
{
	karte_t *welt = world();
	const weighted_vector_tpl<stadt_t *> &cities = welt->get_cities();
	city = NULL;
	if (has_arg(a, "id")) {
		const sint64 i = arg_int(a, "id", -1);
		if (i < 0  ||  i >= (sint64)cities.get_count()) {
			return "no city with this id";
		}
		city = cities[(uint32)i];
	}
	else if (has_arg(a, "name")) {
		const std::string name = arg_str(a, "name");
		for (stadt_t *c : cities) {
			if (name == c->get_name()) {
				city = c;
				break;
			}
		}
		if (city == NULL) {
			for (stadt_t *c : cities) {
				if (equal_nocase(name.c_str(), c->get_name())) {
					city = c;
					break;
				}
			}
		}
		if (city == NULL) {
			return "no city with this name";
		}
	}
	else if (has_arg(a, "x")  &&  has_arg(a, "y")) {
		const koord k((sint16)arg_int(a, "x", -1), (sint16)arg_int(a, "y", -1));
		stadt_t *c = welt->find_nearest_city(k);
		// the corners of the city area are inclusive (stadt_t::recalc_city_size())
		if (c == NULL  ||  k.x < c->get_linksoben().x  ||  k.y < c->get_linksoben().y  ||  k.x > c->get_rechtsunten().x  ||  k.y > c->get_rechtsunten().y) {
			return "no city at this position";
		}
		city = c;
	}
	else {
		return "id=, name= or x= y= needed";
	}
	id = (uint32)cities.index_of(city);
	return NULL;
}


static const char *cmd_city(const args_t &a, json_t &j)
{
	stadt_t *city;
	uint32 id;
	if (const char *err = find_city(a, city, id)) {
		return err;
	}
	const std::string history = arg_str(a, "history", "month");
	if (history != "month"  &&  history != "year"  &&  history != "none"  &&  history != "0") {
		return "history must be month, year or none";
	}
	j.key("city").obj();
	write_city_fields(j, city, id, false);
	write_pos2(j, "center", city->get_center());
	// "City size: citizens (growth)" of the city window: smoothed growth over the last months
	j.kv("growth", city->get_wachstum() / 10.0);
	j.kv("unemployed", (sint64)city->get_unemployed());
	j.kv("homeless", (sint64)city->get_homeless());
	j.kv("allow_growth", city->get_citygrowth());
	j.end_obj();
	if (history == "month") {
		write_stat_table(j, "history", city_stat_columns, lengthof(city_stat_columns), MAX_CITY_HISTORY_MONTHS,
			[&](int m, int t) { return city->get_finance_history_month(m, t); });
	}
	else if (history == "year") {
		write_stat_table(j, "history", city_stat_columns, lengthof(city_stat_columns), MAX_CITY_HISTORY_YEARS,
			[&](int y, int t) { return city->get_finance_history_year(y, t); });
	}
	if (history == "month"  ||  history == "year") {
		j.kv("period", history.c_str());
	}
	return NULL;
}


/// the production chart of the factory window (gui/factory_chart.cc), values converted like there
static const stat_column_t factory_stat_columns[] = {
	{ "production",           FAB_PRODUCTION,     false },
	{ "power",                FAB_POWER,          false },
	{ "boost_electric",       FAB_BOOST_ELECTRIC, false },
	{ "boost_passengers",     FAB_BOOST_PAX,      false },
	{ "boost_mail",           FAB_BOOST_MAIL,     false },
	{ "passengers_generated", FAB_PAX_GENERATED,  false },
	{ "passengers_departed",  FAB_PAX_DEPARTED,   false },
	{ "passengers_arrived",   FAB_PAX_ARRIVED,    false },
	{ "mail_generated",       FAB_MAIL_GENERATED, false },
	{ "mail_departed",        FAB_MAIL_DEPARTED,  false },
	{ "mail_arrived",         FAB_MAIL_ARRIVED,   false }
};

/// the goods chart of the factory window, per input slot and per output slot
static const stat_column_t factory_input_columns[] = {
	{ "storage",    FAB_GOODS_STORAGE,  false },
	{ "received",   FAB_GOODS_RECEIVED, false },
	{ "consumed",   FAB_GOODS_CONSUMED, false },
	{ "in_transit", FAB_GOODS_TRANSIT,  false }
};
static const stat_column_t factory_output_columns[] = {
	{ "storage",   FAB_GOODS_STORAGE,   false },
	{ "delivered", FAB_GOODS_DELIVERED, false },
	{ "produced",  FAB_GOODS_PRODUCED,  false }
};


static void write_factory_slot_history(json_t &j, ware_production_t const &w, bool input)
{
	write_stat_table(j, "history", input ? factory_input_columns : factory_output_columns,
		input ? lengthof(factory_input_columns) : lengthof(factory_output_columns), MAX_MONTH,
		[&](int m, int t) { return w.get_stat_converted(m, t); });
}


static const char *const factory_status_names[] = { "bad", "medium", "good", "inactive", "nothing" };


/// factory at a square of its building or of one of its fields
static fabrik_t *factory_at(koord k)
{
	if (fabrik_t *fab = fabrik_t::get_fab(k)) {
		return fab;
	}
	if (const grund_t *gr = world()->lookup_kartenboden(k)) {
		if (const field_t *field = gr->find<field_t>()) {
			return field->get_factory();
		}
	}
	return NULL;
}


/// the suppliers or consumers of a factory window: position, name, delivered recently
static void write_factory_partners(json_t &j, const char *key, fabrik_t *fab, bool suppliers)
{
	const koord here = fab->get_pos().get_2d();
	j.key(key).arr();
	for (koord k : suppliers ? fab->get_suppliers() : fab->get_consumer()) {
		const fabrik_t *other = fabrik_t::get_fab(k);
		if (other == NULL) {
			continue;
		}
		j.obj();
		j.kv("x", (int)other->get_pos().x);
		j.kv("y", (int)other->get_pos().y);
		j.kv("name", translator::translate(other->get_name()));
		// like the factory window: the link is active if goods went this way recently
		j.kv("active", suppliers ? other->is_active_consumer(here) : fab->is_active_consumer(other->get_pos().get_2d()));
		j.end_obj();
	}
	j.end_arr();
}


static const char *cmd_factory(const args_t &a, json_t &j)
{
	if (!has_arg(a, "x")  ||  !has_arg(a, "y")) {
		return "x= y= needed";
	}
	fabrik_t *fab = factory_at(koord((sint16)arg_int(a, "x", -1), (sint16)arg_int(a, "y", -1)));
	if (fab == NULL) {
		return "no factory at this position";
	}
	const bool history = arg_bool(a, "history", true);
	const factory_desc_t *desc = fab->get_desc();

	j.key("factory").obj();
	write_factory_fields(j, fab, true, false, true, history);
	j.kv("owner", fab->get_owner() ? (int)fab->get_owner()->get_player_nr() : -1);
	const koord size = desc->get_building()->get_size(fab->get_rotate());
	j.key("size").obj().kv("x", (int)size.x).kv("y", (int)size.y).end_obj();
	j.kv("status", fab->get_status() < lengthof(factory_status_names) ? factory_status_names[fab->get_status()] : "?");
	// the factory window: production per day ("Durchsatz"), per minute, base production and boosts in %
	j.kv("base_production", (sint64)fab->get_base_production());
	j.kv("production_per_minute", fab->get_production_per_second() * 60.0);
	j.kv("productivity", convert_boost(fab->get_prodfactor()));
	j.key("boost").obj();
	j.kv("electric", convert_boost(fab->get_prodfactor_electric()));
	j.kv("passengers", convert_boost(fab->get_prodfactor_pax()));
	j.kv("mail", convert_boost(fab->get_prodfactor_mail()));
	j.end_obj();
	j.key("max_boost").obj();
	j.kv("electric", desc->is_electricity_producer() ? (sint64)0 : convert_boost(desc->get_electric_boost()));
	j.kv("passengers", convert_boost(desc->get_pax_boost()));
	j.kv("mail", convert_boost(desc->get_mail_boost()));
	j.end_obj();
	// power in MW like the chart: produced positive, consumed negative
	j.key("power").obj();
	j.kv("mw", fab->get_stat_converted(0, FAB_POWER));
	j.kv("last_month_mw", fab->get_stat_converted(1, FAB_POWER));
	j.kv("producer", desc->is_electricity_producer());
	j.kv("transformer", fab->is_transformer_connected());
	if (desc->is_electricity_producer()) {
		sint64 generation = 0;
		if (fab->is_transformer_connected()) {
			if (const pumpe_t *source = dynamic_cast<const pumpe_t *>(fab->get_transformers().front())) {
				generation = source->get_power_supply();
			}
		}
		j.kv("generation_mw", convert_power(generation));
	}
	else if (desc->get_electric_demand()) {
		j.kv("demand_mw", convert_power(fab->get_scaled_electric_demand()));
	}
	j.end_obj();
	j.kv("fields", fab->get_field_count());
	j.kv("min_fields", fab->get_min_field_count());
	j.end_obj();

	write_factory_partners(j, "suppliers", fab, true);
	write_factory_partners(j, "consumers", fab, false);
	// the stops that serve the factory ("Connected stops" of the factory window)
	j.key("halts").arr();
	if (const planquadrat_t *plan = world()->access(fab->get_pos().get_2d())) {
		for (uint8 i = 0; i < plan->get_haltlist_count(); i++) {
			const halthandle_t halt = plan->get_haltlist()[i];
			if (!halt.is_bound()) {
				continue;
			}
			j.obj();
			j.kv("id", (int)halt.get_id());
			j.kv("name", halt->get_name());
			j.kv("owner", halt->get_first_owner() ? (int)halt->get_first_owner()->get_player_nr() : -1);
			j.end_obj();
		}
	}
	j.end_arr();
	// the cities sending passengers and mail to the factory (the factory window, "supply" of the city)
	j.key("cities").arr();
	for (stadt_t *city : fab->get_target_cities()) {
		const stadt_t::factory_entry_t *pax = city->get_target_factories_for_pax().get_entry(fab);
		const stadt_t::factory_entry_t *mail = city->get_target_factories_for_mail().get_entry(fab);
		j.obj();
		j.kv("id", (uint32)world()->get_cities().index_of(city));
		j.kv("name", city->get_name());
		j.kv("passengers", pax ? (sint64)pax->supply : (sint64)0);
		j.kv("mail", mail ? (sint64)mail->supply : (sint64)0);
		j.end_obj();
	}
	j.end_arr();
	if (history) {
		write_stat_table(j, "history", factory_stat_columns, lengthof(factory_stat_columns), MAX_MONTH,
			[&](int m, int t) { return fab->get_stat_converted(m, t); });
	}
	return NULL;
}


/// goods type by internal or translated name (case does not matter), NULL if unknown
static const goods_desc_t *find_goods(const std::string &name)
{
	for (uint16 i = 0; i < goods_manager_t::get_count(); i++) {
		const goods_desc_t *g = goods_manager_t::get_info(i);
		if (g != goods_manager_t::none  &&  (equal_nocase(name.c_str(), g->get_name())  ||  equal_nocase(name.c_str(), translator::translate(g->get_name())))) {
			return g;
		}
	}
	return NULL;
}


static bool factory_handles(const fabrik_t *fab, const goods_desc_t *g)
{
	for (ware_production_t const &w : fab->get_input()) {
		if (w.get_typ() == g) {
			return true;
		}
	}
	for (ware_production_t const &w : fab->get_output()) {
		if (w.get_typ() == g) {
			return true;
		}
	}
	return false;
}


/**
 * All factories as nodes and their supply links as edges [from node, to node, goods, active]:
 * one edge per goods type that the supplier produces and the consumer accepts.
 */
static const char *cmd_supply_chain(const args_t &a, json_t &j)
{
	const goods_desc_t *only = NULL;
	if (has_arg(a, "goods")) {
		only = find_goods(arg_str(a, "goods"));
		if (only == NULL) {
			return "unknown goods";
		}
	}
	const vector_tpl<fabrik_t *> &fabs = world()->get_fab_list();
	std::unordered_map<const fabrik_t *, uint32> index;
	index.reserve(fabs.get_count());
	if (only) {
		j.kv("goods", translator::translate(only->get_name()));
	}
	j.key("nodes").arr();
	for (fabrik_t *fab : fabs) {
		if (only  &&  !factory_handles(fab, only)) {
			continue;
		}
		const uint32 n = (uint32)index.size();
		index[fab] = n;
		j.obj();
		write_koord3d(j, "pos", fab->get_pos());
		j.kv("name", translator::translate(fab->get_name()));
		j.kv("type", fab->get_desc()->get_name());
		j.end_obj();
	}
	j.end_arr();
	j.key("edges").arr();
	for (fabrik_t *fab : fabs) {
		auto from = index.find(fab);
		if (from == index.end()) {
			continue;
		}
		for (koord k : fab->get_consumer()) {
			const fabrik_t *consumer = fabrik_t::get_fab(k);
			auto to = index.find(consumer);
			if (to == index.end()) {
				continue;
			}
			const bool active = fab->is_active_consumer(consumer->get_pos().get_2d());
			for (ware_production_t const &out : fab->get_output()) {
				if (out.get_typ() == NULL  ||  (only  &&  out.get_typ() != only)) {
					continue;
				}
				for (ware_production_t const &in : consumer->get_input()) {
					if (in.get_typ() == out.get_typ()) {
						j.arr().num(from->second).num(to->second).str(translator::translate(out.get_typ()->get_name())).boolean(active).end_arr();
						break;
					}
				}
			}
		}
	}
	j.end_arr();
	return NULL;
}


/// the goods list window (gui/goods_stats.cc) of all goods types of the pakset
static const char *cmd_goods(const args_t &, json_t &j)
{
	karte_t *welt = world();
	// goods produced or consumed by a factory of this world ("Show only used")
	std::unordered_set<const goods_desc_t *> used;
	for (fabrik_t *fab : welt->get_fab_list()) {
		for (ware_production_t const &w : fab->get_input()) {
			used.insert(w.get_typ());
		}
		for (ware_production_t const &w : fab->get_output()) {
			used.insert(w.get_typ());
		}
	}
	const bool colors = gfx->type != SIMGRAPH_TYPE_NULL;
	const sint64 basefactor = welt->get_settings().get_bonus_basefactor();
	j.key("goods").arr();
	for (uint16 i = 0; i < goods_manager_t::get_count(); i++) {
		const goods_desc_t *g = goods_manager_t::get_info(i);
		if (g == NULL  ||  g == goods_manager_t::none) {
			continue;
		}
		j.obj();
		j.kv("index", (int)g->get_index());
		j.kv("name", g->get_name());
		j.kv("translated", translator::translate(g->get_name()));
		j.kv("unit", goods_unit(g));
		// the category as the goods list shows it; catg 0 = special freight (only interchangeable with itself)
		j.kv("category", translator::translate(g->get_catg_name()));
		j.kv("catg", (int)g->get_catg());
		j.kv("catg_index", (int)g->get_catg_index());
		// the colour of the goods list: index into the palette of the command palette and its rgb, null without graphics
		int color_index = -1;
		if (colors) {
			const PIXVAL c = g->get_color();
			for (int p = 0; p < 256  &&  color_index < 0; p++) {
				if (gfx->palette_lookup((palette_index_t)p) == c) {
					color_index = p;
				}
			}
		}
		j.key("color_index");
		if (color_index >= 0) {
			j.num(color_index);
		}
		else {
			j.null();
		}
		j.key("color");
		if (colors) {
			const rgb888_t rgb = gfx->get_pixval_rgb(g->get_color());
			j.arr().num(rgb.r).num(rgb.g).num(rgb.b).end_arr();
		}
		else {
			j.null();
		}
		// revenue per unit and 100 squares at the average speed, as the goods list shows when it opens
		const sint64 price = std::max(g->get_value() * basefactor, g->get_value() * 1000);
		j.kv("value", (double)price / 3000.0);
		j.kv("speed_bonus", (int)g->get_speed_bonus());
		j.kv("weight", (int)g->get_weight_per_unit());
		j.kv("used", g == goods_manager_t::passengers  ||  g == goods_manager_t::mail  ||  used.count(g) > 0);
		j.end_obj();
	}
	j.end_arr();
	return NULL;
}


/// the chart of the city list window (gui/citylist_frame.cc), karte_t world statistics; unit 1 = 1/100 %, sent as %
static const struct { const char *name; int index; bool percent; } world_stat_columns[] = {
	{ "citizens",             karte_t::WORLD_CITIZENS,          false },
	{ "growth",               karte_t::WORLD_GROWTH,            false },
	{ "towns",                karte_t::WORLD_TOWNS,             false },
	{ "factories",            karte_t::WORLD_FACTORIES,         false },
	{ "convoys",              karte_t::WORLD_CONVOIS,           false },
	{ "citycars",             karte_t::WORLD_CITYCARS,          false },
	{ "passenger_ratio",      karte_t::WORLD_PAS_RATIO,         true },
	{ "passengers_generated", karte_t::WORLD_PAS_GENERATED,     false },
	{ "mail_ratio",           karte_t::WORLD_MAIL_RATIO,        true },
	{ "mail_generated",       karte_t::WORLD_MAIL_GENERATED,    false },
	{ "goods_ratio",          karte_t::WORLD_GOODS_RATIO,       true },
	{ "goods_transported",    karte_t::WORLD_TRANSPORTED_GOODS, false }
};


/**
 * The running month or year of the world statistics. karte_t::update_history() computes it only at the
 * month change and when the city list window draws; compute it the same way here without changing the game.
 */
static void world_stats_current(bool monthly, sint64 *row)
{
	karte_t *welt = world();
	for (int i = 0; i < karte_t::MAX_WORLD_COST; i++) {
		row[i] = monthly ? welt->get_finance_history_month(0, i) : welt->get_finance_history_year(0, i);
	}
	row[karte_t::WORLD_CONVOIS] = welt->convoys().get_count();
	row[karte_t::WORLD_FACTORIES] = welt->get_fab_list().get_count();
	row[karte_t::WORLD_TOWNS] = welt->get_cities().get_count();

	sint64 bev = 0, total_pas = 1, trans_pas = 0, total_mail = 1, trans_mail = 0, total_goods = 1, supplied_goods = 0;
	for (stadt_t *city : welt->get_cities()) {
		bev += city->get_finance_history_month(0, HIST_CITIZENS);
		if (monthly) {
			trans_pas      += city->get_finance_history_month(0, HIST_PAS_TRANSPORTED);
			total_pas      += city->get_finance_history_month(0, HIST_PAS_GENERATED);
			trans_mail     += city->get_finance_history_month(0, HIST_MAIL_TRANSPORTED);
			total_mail     += city->get_finance_history_month(0, HIST_MAIL_GENERATED);
			supplied_goods += city->get_finance_history_month(0, HIST_GOODS_RECEIVED);
			total_goods    += city->get_finance_history_month(0, HIST_GOODS_NEEDED);
		}
		else {
			trans_pas      += city->get_finance_history_year(0, HIST_PAS_TRANSPORTED);
			total_pas      += city->get_finance_history_year(0, HIST_PAS_GENERATED);
			trans_mail     += city->get_finance_history_year(0, HIST_MAIL_TRANSPORTED);
			total_mail     += city->get_finance_history_year(0, HIST_MAIL_GENERATED);
			supplied_goods += city->get_finance_history_year(0, HIST_GOODS_RECEIVED);
			total_goods    += city->get_finance_history_year(0, HIST_GOODS_NEEDED);
		}
	}
	if (monthly) {
		// growth against last month (karte_t::last_month_bev, which is the citizens of last month)
		const sint64 last = welt->get_finance_history_month(1, karte_t::WORLD_CITIZENS);
		if (last != 0) {
			row[karte_t::WORLD_GROWTH] = bev - last;
		}
	}
	else {
		const sint64 last = welt->get_finance_history_year(1, karte_t::WORLD_CITIZENS);
		row[karte_t::WORLD_GROWTH] = last == 0 ? 0 : bev - last;
	}
	row[karte_t::WORLD_CITIZENS] = bev;
	row[karte_t::WORLD_PAS_RATIO] = (10000 * trans_pas) / total_pas;
	row[karte_t::WORLD_PAS_GENERATED] = total_pas - 1;
	row[karte_t::WORLD_MAIL_RATIO] = (10000 * trans_mail) / total_mail;
	row[karte_t::WORLD_MAIL_GENERATED] = total_mail - 1;
	row[karte_t::WORLD_GOODS_RATIO] = (10000 * supplied_goods) / total_goods;

	// transported goods of all players (finance_t::calc_finance_history() sums TT_ALL the same way)
	sint64 transported = 0;
	for (int p = 0; p < MAX_PLAYER_COUNT; p++) {
		if (const player_t *player = welt->get_player(p)) {
			for (int tt = 1; tt < TT_MAX; tt++) {
				transported += monthly ? player->get_finance()->get_history_veh_month((transport_type)tt, 0, ATV_TRANSPORTED_GOOD)
				                       : player->get_finance()->get_history_veh_year((transport_type)tt, 0, ATV_TRANSPORTED_GOOD);
			}
		}
	}
	row[karte_t::WORLD_TRANSPORTED_GOODS] = transported;
}


static const char *cmd_world_stats(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const std::string period = arg_str(a, "period", "month");
	if (period != "month"  &&  period != "year") {
		return "period must be month or year";
	}
	const bool monthly = period == "month";
	sint64 current[karte_t::MAX_WORLD_COST];
	world_stats_current(monthly, current);

	j.kv("period", period.c_str());
	write_date(j, "date", welt->get_current_month());
	j.key("columns").arr();
	for (auto const &c : world_stat_columns) {
		j.str(c.name);
	}
	j.end_arr();
	j.key("rows").arr();
	const int rows = monthly ? MAX_WORLD_HISTORY_MONTHS : MAX_WORLD_HISTORY_YEARS;
	for (int r = 0; r < rows; r++) {
		j.arr();
		for (auto const &c : world_stat_columns) {
			const sint64 v = r == 0 ? current[c.index] : monthly ? welt->get_finance_history_month(r, c.index) : welt->get_finance_history_year(r, c.index);
			if (c.percent) {
				j.dbl((double)v / 100.0);
			}
			else {
				j.num(v);
			}
		}
		j.end_arr();
	}
	j.end_arr();
	return NULL;
}


/**
 * Positions of all convoys on the map as compact rows (front vehicle tile, state index,
 * owner, line id or 0, load in percent); convoys in depots are left out.
 */
static const char *cmd_positions(const args_t &a, json_t &j)
{
	const region_filter_t region(a);
	const bool by_owner = has_arg(a, "owner");
	const sint64 only_owner = arg_int(a, "owner", -1);

	static const char *const cols[] = { "id", "x", "y", "z", "state", "owner", "line", "load" };
	j.key("cols").arr();
	for (const char *c : cols) {
		j.str(c);
	}
	j.end_arr();
	j.key("states").arr();
	for (int s = 0; s < CONVOY_STATE_COUNT; s++) {
		j.str(convoy_state_name(s));
	}
	j.end_arr();

	j.key("rows").arr();
	for (convoihandle_t cnv : world()->convoys()) {
		if (!cnv.is_bound()  ||  cnv->in_depot()  ||  cnv->get_vehicle_count() == 0) {
			continue;
		}
		const vehicle_t *front = cnv->front();
		if (front == NULL  ||  front->get_flag(obj_t::not_on_map)) {
			continue;
		}
		const int owner = cnv->get_owner() ? cnv->get_owner()->get_player_nr() : -1;
		const koord3d pos = front->get_pos();
		if ((by_owner  &&  owner != only_owner)  ||  !region.contains(pos)) {
			continue;
		}
		uint32 cargo = 0, capacity = 0;
		for (uint16 i = 0; i < cnv->get_vehicle_count(); i++) {
			const vehicle_t *v = cnv->get_vehicle(i);
			cargo += v->get_total_cargo();
			capacity += v->get_cargo_max();
		}
		uint32 load = capacity ? (cargo * 100 + capacity / 2) / capacity : 0;
		if (load > 100) {
			load = 100;
		}
		j.arr();
		j.num(cnv.get_id()).num(pos.x).num(pos.y).num(pos.z);
		j.num(cnv->get_state()).num(owner);
		j.num(cnv->get_line().is_bound() ? cnv->get_line().get_id() : 0);
		j.num(load);
		j.end_arr();
	}
	j.end_arr();
	return NULL;
}


// ---------------------------------------------------------------------------
// map export for dashboards: palette, minimap, map_changes, labels
// ---------------------------------------------------------------------------

/// the 224 special colours and 15 day light colours of the palette (copy of simgraph16.cc) for
/// renderers without colours (dedicated server); the indices above are black
static const uint8 builtin_palette[SPECIAL_COLOR_COUNT + LIGHT_COUNT][3] = {
	{ 36,  75, 103 }, { 57,  94, 124 }, { 76, 113, 145 }, { 96, 132, 167 }, {116, 151, 189 }, {136, 171, 211 }, {156, 190, 233 }, {176, 210, 255 },
	{ 88,  88,  88 }, {107, 107, 107 }, {125, 125, 125 }, {144, 144, 144 }, {162, 162, 162 }, {181, 181, 181 }, {200, 200, 200 }, {219, 219, 219 },
	{ 17,  55, 133 }, { 27,  71, 150 }, { 37,  86, 167 }, { 48, 102, 185 }, { 58, 117, 202 }, { 69, 133, 220 }, { 79, 149, 237 }, { 90, 165, 255 },
	{123,  88,   3 }, {142, 111,   4 }, {161, 134,   5 }, {180, 157,   7 }, {198, 180,   8 }, {217, 203,  10 }, {236, 226,  11 }, {255, 249,  13 },
	{ 86,  32,  14 }, {110,  40,  16 }, {134,  48,  18 }, {158,  57,  20 }, {182,  65,  22 }, {206,  74,  24 }, {230,  82,  26 }, {255,  91,  28 },
	{ 34,  59,  10 }, { 44,  80,  14 }, { 53, 101,  18 }, { 63, 122,  22 }, { 77, 143,  29 }, { 92, 164,  37 }, {106, 185,  44 }, {121, 207,  52 },
	{  0,  86,  78 }, {  0, 108,  98 }, {  0, 130, 118 }, {  0, 152, 138 }, {  0, 174, 158 }, {  0, 196, 178 }, {  0, 218, 198 }, {  0, 241, 219 },
	{ 74,   7, 122 }, { 95,  21, 139 }, {116,  37, 156 }, {138,  53, 173 }, {160,  69, 191 }, {181,  85, 208 }, {203, 101, 225 }, {225, 117, 243 },
	{ 59,  41,   0 }, { 83,  55,   0 }, {107,  69,   0 }, {131,  84,   0 }, {155,  98,   0 }, {179, 113,   0 }, {203, 128,   0 }, {227, 143,   0 },
	{ 87,   0,  43 }, {111,  11,  69 }, {135,  28,  92 }, {159,  45, 115 }, {183,  62, 138 }, {230,  74, 174 }, {245, 121, 194 }, {255, 156, 209 },
	{ 20,  48,  10 }, { 44,  74,  28 }, { 68,  99,  45 }, { 93, 124,  62 }, {118, 149,  79 }, {143, 174,  96 }, {168, 199, 113 }, {193, 225, 130 },
	{ 54,  19,  29 }, { 82,  44,  44 }, {110,  69,  58 }, {139,  95,  72 }, {168, 121,  86 }, {197, 147, 101 }, {226, 173, 115 }, {255, 199, 130 },
	{  8,  11, 100 }, { 14,  22, 116 }, { 20,  33, 139 }, { 26,  44, 162 }, { 41,  74, 185 }, { 57, 104, 208 }, { 76, 132, 231 }, { 96, 160, 255 },
	{ 43,  30,  46 }, { 68,  50,  85 }, { 93,  70, 110 }, {118,  91, 130 }, {143, 111, 170 }, {168, 132, 190 }, {193, 153, 210 }, {219, 174, 230 },
	{ 63,  18,  12 }, { 90,  38,  30 }, {117,  58,  42 }, {145,  78,  55 }, {172,  98,  67 }, {200, 118,  80 }, {227, 138,  92 }, {255, 159, 105 },
	{ 11,  68,  30 }, { 33,  94,  56 }, { 54, 120,  81 }, { 76, 147, 106 }, { 98, 174, 131 }, {120, 201, 156 }, {142, 228, 181 }, {164, 255, 207 },
	{ 64,   0,   0 }, { 96,   0,   0 }, {128,   0,   0 }, {192,   0,   0 }, {255,   0,   0 }, {255,  64,  64 }, {255,  96,  96 }, {255, 128, 128 },
	{  0, 128,   0 }, {  0, 196,   0 }, {  0, 225,   0 }, {  0, 240,   0 }, {  0, 255,   0 }, { 64, 255,  64 }, { 94, 255,  94 }, {128, 255, 128 },
	{  0,   0, 128 }, {  0,   0, 192 }, {  0,   0, 224 }, {  0,   0, 255 }, {  0,  64, 255 }, {  0,  94, 255 }, {  0, 106, 255 }, {  0, 128, 255 },
	{128,  64,   0 }, {193,  97,   0 }, {215, 107,   0 }, {235, 118,   0 }, {255, 128,   0 }, {255, 149,  43 }, {255, 170,  85 }, {255, 193, 132 },
	{  8,  52,   0 }, { 16,  64,   0 }, { 32,  80,   4 }, { 48,  96,   4 }, { 64, 112,  12 }, { 84, 132,  20 }, {104, 148,  28 }, {128, 168,  44 },
	{164, 164,   0 }, {180, 180,   0 }, {193, 193,   0 }, {215, 215,   0 }, {235, 235,   0 }, {255, 255,   0 }, {255, 255,  64 }, {255, 255, 128 },
	{ 32,   4,   0 }, { 64,  20,   8 }, { 84,  28,  16 }, {108,  44,  28 }, {128,  56,  40 }, {148,  72,  56 }, {168,  92,  76 }, {184, 108,  88 },
	{ 64,   0,   0 }, { 96,   8,   0 }, {112,  16,   0 }, {120,  32,   8 }, {138,  64,  16 }, {156,  72,  32 }, {174,  96,  48 }, {192, 128,  64 },
	{ 32,  32,   0 }, { 64,  64,   0 }, { 96,  96,   0 }, {128, 128,   0 }, {144, 144,   0 }, {172, 172,   0 }, {192, 192,   0 }, {224, 224,   0 },
	{ 64,  96,   8 }, { 80, 108,  32 }, { 96, 120,  48 }, {112, 144,  56 }, {128, 172,  64 }, {150, 210,  68 }, {172, 238,  80 }, {192, 255,  96 },
	{ 32,  32,  32 }, { 48,  48,  48 }, { 64,  64,  64 }, { 80,  80,  80 }, { 96,  96,  96 }, {172, 172, 172 }, {236, 236, 236 }, {255, 255, 255 },
	{ 41,  41,  54 }, { 60,  45,  70 }, { 75,  62, 108 }, { 95,  77, 136 }, {113, 105, 150 }, {135, 120, 176 }, {165, 145, 218 }, {198, 191, 232 },
	{ 87, 101, 111 }, {127, 155, 241 }, {255, 255,  83 }, {255,  33,  29 }, {  1, 221,   1 }, {107, 107, 107 }, {155, 155, 155 }, {179, 179, 179 },
	{201, 201, 201 }, {223, 223, 223 }, {227, 227, 255 }, {193, 177, 209 }, { 77,  77,  77 }, {225,   0, 225 }, {  1,   1, 255 },
};


#define MAP_CELL_SHIFT 6                  ///< changes are recorded per cell of 64x64 squares
#define MAP_CELL (1 << MAP_CELL_SHIFT)
#define MAP_TRACK_IDLE_TIMEOUT 120000     ///< ms without map requests or polls until the tracking stops
#define MAP_SWEEP_TILES_PER_SECOND 65536  ///< background re-check of all squares
#define MAP_SWEEP_MAX_PER_POLL 8192       ///< at most this many squares per poll (about 0.5 ms; slow frames re-check slower)
#define MAP_SCAN_UNTIL_US 4000            ///< the first pass scans cells until this long after the start of the poll
#define MAX_MINIMAP_SAMPLES (1024*1024)

/**
 * Change tracking of the map for map_changes, started by the first minimap, map_changes, scene3d or
 * heights request. Every square keeps its terrain and owner colour; minimap_t::calc_map_pixel(koord),
 * which the game calls for every changed square (and when a vehicle moves while the minimap is open),
 * compares them and records a change only if one of them changed. A slow background re-check finds
 * the changes that do not go through calc_map_pixel (e.g. owner changes). Changes that keep the
 * colours (a city building replaced, a way extended, a sign added, ...) come from the engine hooks
 * (remote_control_mark_changed), which flag cells; map_tracking_fold() records them.
 * The first pass that takes the colours is spread over the polls, one cell after the other (a
 * whole 1024x1024 map would stop the game for some 40 ms); a request scans the cells it needs at
 * once. A cell counts as changed when it is scanned, since nothing was compared before.
 */
struct map_tracking_t
{
	bool active = false;
	uint32 world_gen = 0;           ///< world, rotation and size seen last (tracked or by poll)
	uint8 rotation = 0;
	koord size = koord(0, 0);
	uint32 start_gen = 0;           ///< map gen when the tracking started: older since give full
	koord cells = koord(0, 0);
	std::vector<uint16> sig;        ///< per square: terrain colour << 8 | owner colour (once its cell is scanned)
	std::vector<uint32> cell_gen;   ///< per cell: map gen of its last change
	std::vector<uint8> cell_scanned; ///< per cell: sig holds its colours
	uint32 cells_left = 0;          ///< cells not scanned yet
	uint32 scan_next = 0;           ///< the cells before this one are scanned
	uint32 sweep_next = 0;          ///< next square of the background re-check
	uint32 sweep_time = 0;
	uint32 last_use = 0;            ///< dr_time() of the last minimap, map_changes or poll
};

static map_tracking_t map_track;
static uint32 map_gen = 1; ///< revision of the map: changes, other worlds, rotations (never reset)

bool remote_control_map_tracked = false;

/// per cell: changed according to an engine hook, not yet recorded in cell_gen (written from any thread)
static std::unique_ptr<std::atomic<uint8>[]> map_dirty;
static std::atomic<bool> map_dirty_any(false);
static int map_dirty_w = 0, map_dirty_h = 0, map_dirty_cells_x = 0;


/**
 * Engine hook (see remote_control.h): flags the cells of the square and of its eight neighbours,
 * since an object also changes how the next squares look (ways, overhead lines, power lines).
 * The world's worker threads (loading, rotation) may call it at the same time while the main
 * thread waits for them; the arrays only change on the main thread outside of such calls.
 */
void remote_control_mark_changed(int x, int y)
{
	const int w = map_dirty_w, h = map_dirty_h;
	if (x < 0  ||  y < 0  ||  x >= w  ||  y >= h) {
		return;
	}
	const int cx0 = max(x - 1, 0) >> MAP_CELL_SHIFT, cx1 = min(x + 1, w - 1) >> MAP_CELL_SHIFT;
	const int cy0 = max(y - 1, 0) >> MAP_CELL_SHIFT, cy1 = min(y + 1, h - 1) >> MAP_CELL_SHIFT;
	for (int cy = cy0; cy <= cy1; cy++) {
		for (int cx = cx0; cx <= cx1; cx++) {
			map_dirty[cy * map_dirty_cells_x + cx].store(1, std::memory_order_relaxed);
		}
	}
	map_dirty_any.store(true, std::memory_order_relaxed);
}


/// records the cells flagged by the engine hooks as changed (main thread)
static void map_tracking_fold()
{
	if (!map_track.active  ||  !map_dirty_any.exchange(false, std::memory_order_relaxed)) {
		return;
	}
	const size_t cells = map_track.cell_gen.size();
	for (size_t i = 0; i < cells; i++) {
		if (map_dirty[i].load(std::memory_order_relaxed)) {
			map_dirty[i].store(0, std::memory_order_relaxed);
			map_track.cell_gen[i] = ++map_gen;
		}
	}
}

static const minimap_t::color_scale_t unit_scale = { 1, 1, 1 };


/// terrain colour << 8 | owner colour of a square
static uint16 tile_signature(koord k)
{
	const palette_index_t terrain = minimap_t::calc_tile_color_index(k, minimap_t::PLAIN, unit_scale, false);
	const palette_index_t owner = minimap_t::calc_tile_color_index(k, minimap_t::MAP_OWNER, unit_scale, false);
	return (uint16)((terrain << 8) | owner);
}


/// compares the colours of a tracked square and records a change
static void map_check_tile(koord k)
{
	uint16 &old = map_track.sig[(uint32)k.y * (uint32)map_track.size.x + (uint32)k.x];
	const uint16 now = tile_signature(k);
	if (now != old) {
		old = now;
		map_track.cell_gen[(uint32)(k.y >> MAP_CELL_SHIFT) * (uint32)map_track.cells.x + (uint32)(k.x >> MAP_CELL_SHIFT)] = ++map_gen;
	}
}


static uint32 map_cell_of(koord k)
{
	return (uint32)(k.y >> MAP_CELL_SHIFT) * (uint32)map_track.cells.x + (uint32)(k.x >> MAP_CELL_SHIFT);
}


/// takes the colours of the squares of a cell that is not scanned yet; the cell counts as changed
static void map_scan_cell(uint32 cell)
{
	const koord size = map_track.size;
	const sint16 x0 = (sint16)((cell % (uint32)map_track.cells.x) << MAP_CELL_SHIFT);
	const sint16 y0 = (sint16)((cell / (uint32)map_track.cells.x) << MAP_CELL_SHIFT);
	const sint16 x1 = (sint16)min(x0 + MAP_CELL, (int)size.x), y1 = (sint16)min(y0 + MAP_CELL, (int)size.y);
	koord k;
	for (k.y = y0; k.y < y1; k.y++) {
		uint16 *row = map_track.sig.data() + (size_t)k.y * size.x;
		for (k.x = x0; k.x < x1; k.x++) {
			row[k.x] = tile_signature(k);
		}
	}
	map_track.cell_scanned[cell] = 1;
	map_track.cells_left--;
	map_track.cell_gen[cell] = ++map_gen;
}


/// scans the cells of a region (inside the map) now; the tracking must be active
static void map_tracking_scan(koord pos, koord size)
{
	if (map_track.cells_left == 0) {
		return;
	}
	const sint16 cx1 = (sint16)((pos.x + size.x - 1) >> MAP_CELL_SHIFT), cy1 = (sint16)((pos.y + size.y - 1) >> MAP_CELL_SHIFT);
	for (sint16 cy = (sint16)(pos.y >> MAP_CELL_SHIFT); cy <= cy1; cy++) {
		for (sint16 cx = (sint16)(pos.x >> MAP_CELL_SHIFT); cx <= cx1; cx++) {
			const uint32 cell = (uint32)cy * (uint32)map_track.cells.x + (uint32)cx;
			if (!map_track.cell_scanned[cell]) {
				map_scan_cell(cell);
			}
		}
	}
}


static void map_tracking_scan_at(koord pos)
{
	map_tracking_scan(pos, koord(1, 1));
}


/// minimap_t::tile_changed_hook while the tracking is active
static void on_tile_changed(koord k)
{
	karte_t *welt = world();
	if (!map_track.active  ||  welt == NULL  ||  k.x < 0  ||  k.y < 0  ||  k.x >= map_track.size.x  ||  k.y >= map_track.size.y) {
		return;
	}
	if (map_track.world_gen != remote_control_world_generation  ||  map_track.rotation != welt->get_settings().get_rotation()  ||  map_track.size != welt->get_size()) {
		return; // another world or rotated: the next request starts again
	}
	if (map_track.cell_scanned[map_cell_of(k)]) {
		map_check_tile(k); // a cell not scanned yet counts as changed when it is scanned
	}
}


static void map_tracking_stop()
{
	map_track.active = false;
	minimap_t::tile_changed_hook = NULL;
	remote_control_map_tracked = false;
	map_dirty_w = map_dirty_h = map_dirty_cells_x = 0;
	map_dirty.reset();
	map_dirty_any.store(false, std::memory_order_relaxed);
	std::vector<uint16>().swap(map_track.sig);
	std::vector<uint32>().swap(map_track.cell_gen);
	std::vector<uint8>().swap(map_track.cell_scanned);
	map_track.cells_left = 0;
}


/// notices another world, a rotation or a new map size: stops the tracking and counts a map change
static void map_tracking_validate()
{
	karte_t *welt = world();
	const uint8 rotation = welt->get_settings().get_rotation();
	if (map_track.world_gen != remote_control_world_generation  ||  map_track.rotation != rotation  ||  map_track.size != welt->get_size()) {
		map_tracking_stop();
		map_track.world_gen = remote_control_world_generation;
		map_track.rotation = rotation;
		map_track.size = welt->get_size();
		map_gen++;
	}
	map_tracking_fold();
}


/// starts the tracking if needed; the cells are scanned later (map_tracking_poll, map_tracking_scan)
static void map_tracking_start()
{
	map_tracking_validate();
	map_track.last_use = dr_time();
	if (map_track.active) {
		return;
	}
	const koord size = map_track.size;
	map_track.cells = koord((size.x + MAP_CELL - 1) >> MAP_CELL_SHIFT, (size.y + MAP_CELL - 1) >> MAP_CELL_SHIFT);
	const size_t cells = (size_t)map_track.cells.x * map_track.cells.y;
	map_track.start_gen = ++map_gen;
	map_track.cell_gen.assign(cells, map_track.start_gen);
	map_track.cell_scanned.assign(cells, 0);
	map_track.cells_left = (uint32)cells;
	map_track.scan_next = 0;
	map_track.sig.assign((size_t)size.x * size.y, 0);
	map_track.sweep_next = 0;
	map_track.sweep_time = dr_time();
	map_dirty.reset(new std::atomic<uint8>[cells]());
	map_dirty_any.store(false, std::memory_order_relaxed);
	map_dirty_w = size.x;
	map_dirty_h = size.y;
	map_dirty_cells_x = map_track.cells.x;
	map_track.active = true;
	minimap_t::tile_changed_hook = on_tile_changed;
	remote_control_map_tracked = true;
}


/**
 * Called every poll: stops unused tracking, notices other worlds, continues the first pass (at
 * least one cell, more until MAP_SCAN_UNTIL_US after poll_start), afterwards re-checks some squares.
 */
static void map_tracking_poll(uint32 now, bool any_client, uint64 poll_start)
{
	if (!map_track.active) {
		return;
	}
	if (!any_client  ||  world() == NULL  ||  now - map_track.last_use > MAP_TRACK_IDLE_TIMEOUT) {
		map_tracking_stop();
		return;
	}
	map_tracking_validate();
	if (!map_track.active) {
		return;
	}
	if (map_track.cells_left > 0) {
		do {
			while (map_track.cell_scanned[map_track.scan_next]) {
				map_track.scan_next++;
			}
			map_scan_cell(map_track.scan_next);
		} while (map_track.cells_left > 0  &&  time_us() - poll_start < MAP_SCAN_UNTIL_US);
		map_track.sweep_time = now;
		return;
	}
	const uint32 elapsed = now - map_track.sweep_time;
	if (elapsed < 20) {
		return;
	}
	map_track.sweep_time = now;
	uint32 n = std::min<uint32>(std::min<uint32>(elapsed, 1000) * MAP_SWEEP_TILES_PER_SECOND / 1000, MAP_SWEEP_MAX_PER_POLL);
	const uint32 w = (uint32)map_track.size.x;
	const uint32 total = w * (uint32)map_track.size.y;
	while (n-- > 0) {
		map_check_tile(koord((sint16)(map_track.sweep_next % w), (sint16)(map_track.sweep_next / w)));
		if (++map_track.sweep_next >= total) {
			map_track.sweep_next = 0;
		}
	}
}


static void write_rgb(json_t &j, uint8 r, uint8 g, uint8 b)
{
	j.arr().num(r).num(g).num(b).end_arr();
}


/**
 * The 256 colour palette of the minimap (day colours) and what the dashboard needs to draw
 * minimap samples: player colours, height and severity colour tables, heights, rotation.
 */
static const char *cmd_palette(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const bool builtin = gfx->type == SIMGRAPH_TYPE_NULL  ||  arg_bool(a, "builtin", false);
	j.kv("source", builtin ? "builtin" : "renderer");
	j.key("colors").arr();
	for (int i = 0; i < 256; i++) {
		if (builtin) {
			if (i < SPECIAL_COLOR_COUNT + LIGHT_COUNT) {
				write_rgb(j, builtin_palette[i][0], builtin_palette[i][1], builtin_palette[i][2]);
			}
			else {
				write_rgb(j, 0, 0, 0);
			}
		}
		else {
			const rgb888_t c = gfx->get_color_rgb((palette_index_t)i);
			write_rgb(j, c.r, c.g, c.b);
		}
	}
	j.end_arr();

	j.key("players").arr();
	for (int i = 0; i < MAX_PLAYER_COUNT; i++) {
		if (player_t *player = welt->get_player(i)) {
			j.obj();
			j.kv("nr", i);
			j.kv("name", player->get_name());
			j.kv("color1", (int)player->get_player_color1());
			j.kv("color2", (int)player->get_player_color2());
			j.kv("minimap_color", (int)(uint8)(player->get_player_color1() + 3));
			j.end_obj();
		}
	}
	j.end_arr();

	j.key("height_colors").arr();
	for (int i = 0; i < minimap_t::get_height_color_count(); i++) {
		j.num(minimap_t::get_height_color_table(i));
	}
	j.end_arr();
	j.key("severity_colors").arr();
	for (int i = 0; i < MAX_SEVERITY_COLORS; i++) {
		j.num(minimap_t::get_severity_color_table(i));
	}
	j.end_arr();
	j.kv("maximumheight", (int)welt->get_settings().get_maximumheight());
	j.kv("minimumheight", (int)welt->get_settings().get_minimumheight());
	j.kv("groundwater", (int)welt->get_groundwater());
	j.kv("rotation", (int)welt->get_settings().get_rotation());
	return NULL;
}


struct minimap_mode_t
{
	const char *name;
	uint32 mode;
};

static const minimap_mode_t minimap_modes[] = {
	{ "terrain",    minimap_t::PLAIN },
	{ "owner",      minimap_t::MAP_OWNER },
	{ "traffic",    minimap_t::MAP_TRAFFIC },
	{ "freight",    minimap_t::MAP_FREIGHT },
	{ "passengers", minimap_t::MAP_PASSENGER },
	{ "mail",       minimap_t::MAP_MAIL },
	{ "tracks",     minimap_t::MAP_TRACKS },
	{ "speed",      minimap_t::MAX_SPEEDLIMIT },
	{ "power",      minimap_t::MAP_POWERLINES },
	{ "forest",     minimap_t::MAP_FOREST },
	{ "level",      minimap_t::MAP_LEVEL },
	{ "climates",   minimap_t::MAP_CLIMATES },
};


/// maxima of freight, traffic and level over the whole map, kept per world, rotation and month
static minimap_t::color_scale_t get_map_scale(uint32 mode)
{
	static uint32 cached_world = 0, cached_month = 0, cached_modes = 0;
	static uint8 cached_rotation = 0;
	static minimap_t::color_scale_t scale = { 1, 1, 1 };
	karte_t *welt = world();
	const uint32 month = welt->get_current_month();
	if (cached_world != remote_control_world_generation  ||  cached_month != month  ||  cached_rotation != welt->get_settings().get_rotation()) {
		cached_world = remote_control_world_generation;
		cached_month = month;
		cached_rotation = welt->get_settings().get_rotation();
		cached_modes = 0;
		scale.max_cargo = scale.max_passed = scale.max_level = 1;
	}
	if (cached_modes & mode) {
		return scale;
	}
	sint32 &max_value = mode == minimap_t::MAP_FREIGHT ? scale.max_cargo : mode == minimap_t::MAP_TRAFFIC ? scale.max_passed : scale.max_level;
	const koord size = welt->get_size();
	koord k;
	for (k.y = 0; k.y < size.y; k.y++) {
		for (k.x = 0; k.x < size.x; k.x++) {
			const planquadrat_t *plan = welt->access(k);
			for (uint8 i = 0; i < plan->get_boden_count(); i++) {
				sint32 value;
				if (minimap_t::get_scaled_value(plan->get_boden_bei(i), (minimap_t::MAP_DISPLAY_MODE)mode, value)  &&  value > max_value) {
					max_value = value;
				}
			}
		}
	}
	cached_modes |= mode;
	return scale;
}


static void append_base64(std::string &out, const uint8 *data, size_t len)
{
	static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	out.reserve(out.size() + (len + 2) / 3 * 4);
	size_t i = 0;
	for (; i + 2 < len; i += 3) {
		const uint32 v = (uint32)data[i] << 16 | (uint32)data[i+1] << 8 | data[i+2];
		out += digits[v >> 18];
		out += digits[(v >> 12) & 63];
		out += digits[(v >> 6) & 63];
		out += digits[v & 63];
	}
	if (i < len) {
		const uint32 v = (uint32)data[i] << 16 | (i + 1 < len ? (uint32)data[i+1] << 8 : 0);
		out += digits[v >> 18];
		out += digits[(v >> 12) & 63];
		out += i + 1 < len ? digits[(v >> 6) & 63] : '=';
		out += '=';
	}
}


/**
 * The minimap of a region as one palette index per sample (the colours of the in-game minimap in
 * the normal view), row after row, zlib compressed and base64 encoded. With step > 1 the top left
 * square of every step x step block is sampled, like the zoomed out minimap does.
 */
static const char *cmd_minimap(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const koord size = welt->get_size();
	const sint64 step = arg_int(a, "step", 1);
	if (step != 1  &&  step != 2  &&  step != 4  &&  step != 8  &&  step != 16) {
		return "step must be 1, 2, 4, 8 or 16";
	}
	sint64 x = arg_int(a, "x", 0), y = arg_int(a, "y", 0);
	sint64 w = arg_int(a, "w", size.x), h = arg_int(a, "h", size.y);
	if (x < 0) {
		w += x;
		x = 0;
	}
	if (y < 0) {
		h += y;
		y = 0;
	}
	w = std::min<sint64>(w, size.x - x);
	h = std::min<sint64>(h, size.y - y);
	if (w <= 0  ||  h <= 0) {
		return "region is outside of the map";
	}
	const sint64 sw = (w + step - 1) / step, sh = (h + step - 1) / step;
	if (sw * sh > MAX_MINIMAP_SAMPLES) {
		return "too many samples (at most 1048576 per request): use a larger step or a smaller region";
	}

	const std::string mode_name = arg_str(a, "mode", "terrain");
	const minimap_mode_t *found = NULL;
	for (const minimap_mode_t &m : minimap_modes) {
		if (mode_name == m.name) {
			found = &m;
		}
	}
	if (mode_name == "passenger") {
		found = &minimap_modes[4];
	}
	if (found == NULL) {
		return "unknown mode (terrain owner traffic freight passengers mail tracks speed power forest level climates)";
	}
	uint32 mode = found->mode;
	if (!arg_bool(a, "contour", true)) {
		mode |= minimap_t::MAP_HIDE_CONTOUR;
	}
	const bool vehicles = arg_bool(a, "vehicles", false);
	const int level = (int)clamp<sint64>(arg_int(a, "level", 6), 1, 9);

	map_tracking_start();
	const bool tracked_colours = !vehicles  &&  (mode == minimap_t::PLAIN  ||  mode == minimap_t::MAP_OWNER);
	if (tracked_colours  &&  step == 1) {
		map_tracking_scan(koord((sint16)x, (sint16)y), koord((sint16)w, (sint16)h));
	}
	std::vector<uint8> samples((size_t)(sw * sh));
	uint8 *out = samples.data();
	if (tracked_colours  &&  (step == 1  ||  map_track.cells_left == 0)) {
		// the colours kept for the change tracking
		const int shift = mode == minimap_t::PLAIN ? 8 : 0;
		for (sint64 sy = 0; sy < sh; sy++) {
			const uint16 *row = map_track.sig.data() + (size_t)(y + sy * step) * size.x + x;
			for (sint64 sx = 0; sx < sw; sx++) {
				*out++ = (uint8)(row[sx * step] >> shift);
			}
		}
	}
	else {
		const minimap_t::color_scale_t scale = (found->mode == minimap_t::MAP_FREIGHT  ||  found->mode == minimap_t::MAP_TRAFFIC  ||  found->mode == minimap_t::MAP_LEVEL) ? get_map_scale(found->mode) : unit_scale;
		if (found->mode == minimap_t::MAP_FREIGHT) {
			j.kv("max", scale.max_cargo);
		}
		else if (found->mode == minimap_t::MAP_TRAFFIC) {
			j.kv("max", scale.max_passed);
		}
		else if (found->mode == minimap_t::MAP_LEVEL) {
			j.kv("max", scale.max_level);
		}
		koord k;
		for (sint64 sy = 0; sy < sh; sy++) {
			k.y = (sint16)(y + sy * step);
			for (sint64 sx = 0; sx < sw; sx++) {
				k.x = (sint16)(x + sx * step);
				*out++ = minimap_t::calc_tile_color_index(k, (minimap_t::MAP_DISPLAY_MODE)mode, scale, vehicles);
			}
		}
	}

	uLongf packed_len = compressBound((uLong)samples.size());
	std::vector<uint8> packed(packed_len);
	if (compress2(packed.data(), &packed_len, samples.data(), (uLong)samples.size(), level) != Z_OK) {
		return "compression failed";
	}
	std::string encoded;
	append_base64(encoded, packed.data(), packed_len);

	j.key("region").obj().kv("x", (int)x).kv("y", (int)y).kv("w", (int)w).kv("h", (int)h).end_obj();
	j.kv("step", (int)step);
	j.kv("mode", found->name);
	j.kv("encoding", "zlib+base64");
	j.kv("width", (int)sw);
	j.kv("height", (int)sh);
	j.kv("gen", map_gen);
	j.key("data").safe_str(encoded.c_str(), encoded.size());
	return NULL;
}


/**
 * Map areas that changed since a map gen (of a minimap reply or an earlier map_changes), as chunks
 * of chunk x chunk squares; full=true means: fetch everything again.
 */
static const char *cmd_map_changes(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const sint64 since = arg_int(a, "since", 0);
	const sint64 chunk = arg_int(a, "chunk", 256);
	if (chunk < MAP_CELL  ||  chunk > 4096  ||  (chunk & (chunk - 1)) != 0) {
		return "chunk must be a power of 2 from 64 to 4096";
	}
	map_tracking_start();
	const bool full = since < (sint64)map_track.start_gen  ||  since > (sint64)map_gen;
	j.kv("gen", map_gen);
	j.kv("full", full);
	j.kv("chunk", (int)chunk);
	j.key("chunks").arr();
	if (!full) {
		const int per = (int)(chunk >> MAP_CELL_SHIFT);
		const koord cells = map_track.cells;
		for (int cy = 0; cy * per < cells.y; cy++) {
			for (int cx = 0; cx * per < cells.x; cx++) {
				bool changed = false;
				for (int y = cy * per; y < min((cy + 1) * per, (int)cells.y)  &&  !changed; y++) {
					for (int x = cx * per; x < min((cx + 1) * per, (int)cells.x); x++) {
						if (map_track.cell_gen[(size_t)y * cells.x + x] > since) {
							changed = true;
							break;
						}
					}
				}
				if (changed) {
					j.arr().num(cx).num(cy).end_arr();
				}
			}
		}
	}
	j.end_arr();
	j.kv("rotation", (int)welt->get_settings().get_rotation());
	j.kv("world_gen", (uint32)remote_control_world_generation);
	j.kv("size_x", (int)welt->get_size().x);
	j.kv("size_y", (int)welt->get_size().y);
	return NULL;
}


/// all labels (map markers) of the world
static const char *cmd_labels(const args_t &, json_t &j)
{
	karte_t *welt = world();
	j.key("labels").arr();
	for (koord k : welt->get_label_list()) {
		const grund_t *gr = welt->lookup_kartenboden(k);
		if (gr == NULL) {
			continue;
		}
		const label_t *lb = gr->find<label_t>();
		const char *text = gr->get_text();
		j.obj();
		write_koord3d(j, "pos", gr->get_pos());
		j.kv("text", text ? text : "");
		j.kv("owner", lb ? owner_of(lb->get_owner_nr()) : -1);
		j.end_obj();
	}
	j.end_arr();
	return NULL;
}


// ---------------------------------------------------------------------------
// 3D view export: desc_list, scene3d, heights, vehicles3d
// ---------------------------------------------------------------------------

/// the lists of desc_list, in this order
enum desc_kind_t
{
	DESC_BUILDINGS, DESC_VEHICLES, DESC_WAYS, DESC_BRIDGES, DESC_TUNNELS, DESC_TREES, DESC_SIGNS, DESC_WAYOBJS, DESC_GOODS,
	DESC_CITYCARS, DESC_PEDESTRIANS,
	DESC_KINDS
};

static const char *const desc_kind_names[DESC_KINDS] = {
	"buildings", "vehicles", "ways", "bridges", "tunnels", "trees", "signs", "wayobjs", "goods", "citycars", "pedestrians"
};


/**
 * Catalog of the pak objects with the indices that scene3d uses instead of names: every list is
 * sorted by the untranslated names (trees by tree id, which follows the names too). The pakset
 * does not change while the program runs, so it is built once, together with the JSON of the lists.
 */
struct desc_catalog_t
{
	bool built = false;
	uint32 gen = 0;                                          ///< FNV-1a hash of all lists
	std::string json[DESC_KINDS];                            ///< every list as a JSON array
	std::unordered_map<const void *, int> index[DESC_KINDS]; ///< desc -> i (trees: i is the tree id)
};


template<class T> static bool desc_name_less(const T *a, const T *b)
{
	return strcmp(a->get_name(), b->get_name()) < 0;
}


/// NULL for no waytype (ignore_wt)
static const char *waytype_name(waytype_t wt)
{
	switch (wt) {
		case road_wt:          return "road";
		case track_wt:         return "track";
		case water_wt:         return "water";
		case overheadlines_wt: return "overheadline";
		case monorail_wt:      return "monorail";
		case maglev_wt:        return "maglev";
		case tram_wt:          return "tram";
		case narrowgauge_wt:   return "narrowgauge";
		case air_wt:           return "air";
		case powerline_wt:     return "powerline";
		case invalid_wt:
		case ignore_wt:        return NULL;
		default:               return "other";
	}
}


static const char *way_waytype_name(const way_desc_t *desc)
{
	if (desc->get_wtyp() == track_wt  &&  desc->get_styp() == type_tram) {
		return "tram"; // tram tracks are track ways of the system type tram
	}
	const char *name = waytype_name(desc->get_wtyp());
	return name ? name : "other";
}


static const char *way_system_name(const way_desc_t *desc)
{
	switch (desc->get_styp()) {
		case type_flat:     return "flat";
		case type_elevated: return desc->get_wtyp() == air_wt ? "runway" : "elevated";
		case type_tram:     return "tram";
		case type_river:    return "river";
		default:            return "other";
	}
}


static const char *building_type_name(const building_desc_t *desc)
{
	switch (desc->get_type()) {
		case building_desc_t::city_res:          return "res";
		case building_desc_t::city_com:          return "com";
		case building_desc_t::city_ind:          return "ind";
		case building_desc_t::attraction_city:
		case building_desc_t::attraction_land:   return "cur";
		case building_desc_t::monument:          return "mon";
		case building_desc_t::townhall:          return "tow";
		case building_desc_t::headquarters:      return "hq";
		case building_desc_t::dock:
		case building_desc_t::flat_dock:
		case building_desc_t::generic_stop:      return "stop";
		case building_desc_t::generic_extension: return "ext";
		case building_desc_t::depot:             return "depot";
		case building_desc_t::factory:           return "factory";
		default:                                 return "other";
	}
}


static void write_timeline(json_t &j, const obj_desc_timelined_t *desc)
{
	j.kv("intro", (int)(desc->get_intro_year_month() / 12));
	j.kv("retire", (int)(desc->get_retire_year_month() / 12));
}


/// sorts a list by name, numbers it and writes it as JSON array (i, name, then what write() adds)
template<class T, class F> static void catalog_add(desc_catalog_t &cat, desc_kind_t kind, vector_tpl<const T *> &list, F write)
{
	std::sort(list.begin(), list.end(), desc_name_less<T>);
	json_t j;
	j.arr();
	for (uint32 i = 0; i < list.get_count(); i++) {
		cat.index[kind][list[i]] = (int)i;
		j.obj().kv("i", (int)i).kv("name", list[i]->get_name());
		write(j, list[i]);
		j.end_obj();
	}
	j.end_arr();
	cat.json[kind].swap(j.text());
}


static uint32 fnv1a(uint32 h, const char *s, size_t len)
{
	for (size_t i = 0; i < len; i++) {
		h = (h ^ (uint8)s[i]) * 16777619u;
	}
	return h;
}


static const desc_catalog_t &get_desc_catalog()
{
	static desc_catalog_t cat;
	if (cat.built) {
		return cat;
	}

	vector_tpl<const building_desc_t *> buildings;
	hausbauer_t::get_all_desc(buildings);
	catalog_add(cat, DESC_BUILDINGS, buildings, [](json_t &j, const building_desc_t *d) {
		const char *type = building_type_name(d);
		j.kv("type", type);
		j.key("size").arr().num(d->get_x()).num(d->get_y()).end_arr();
		j.kv("layouts", (int)d->get_all_layouts());
		j.kv("level", (int)d->get_level());
		j.kv("height", (int)d->get_height_clearance());
		j.kv("climates", (int)d->get_allowed_climate_bits());
		j.kv("waytype", waytype_name(d->get_finance_waytype()));
		if (strcmp(type, "stop") == 0  ||  strcmp(type, "ext") == 0) {
			j.kv("enables", (int)d->get_enabled());
		}
		write_timeline(j, d);
	});

	vector_tpl<const vehicle_desc_t *> vehicles;
	for (int wt = 0; wt <= narrowgauge_wt; wt++) {
		// the vehicle lists by waytype index: 1-8 are the waytypes, 0 holds aircraft and all others
		for (const vehicle_desc_t *d : vehicle_builder_t::get_info((waytype_t)wt)) {
			vehicles.append(d);
		}
	}
	catalog_add(cat, DESC_VEHICLES, vehicles, [](json_t &j, const vehicle_desc_t *d) {
		j.kv("waytype", waytype_name(d->get_waytype()));
		j.kv("length", (int)d->get_length());
		const goods_desc_t *freight = d->get_freight_type();
		j.kv("freight", freight ? freight->get_name() : NULL);
		j.kv("capacity", (int)d->get_capacity());
		j.kv("power", (uint32)d->get_power());
		j.kv("speed", (int)d->get_topspeed());
		write_timeline(j, d);
	});

	vector_tpl<const way_desc_t *> ways;
	way_builder_t::get_all_desc(ways);
	catalog_add(cat, DESC_WAYS, ways, [](json_t &j, const way_desc_t *d) {
		j.kv("waytype", way_waytype_name(d));
		j.kv("system", way_system_name(d));
		j.kv("speed", (int)d->get_topspeed());
	});

	vector_tpl<const bridge_desc_t *> bridges;
	bridge_builder_t::get_all_desc(bridges);
	catalog_add(cat, DESC_BRIDGES, bridges, [](json_t &j, const bridge_desc_t *d) {
		j.kv("waytype", waytype_name(d->get_waytype()));
		j.kv("speed", (int)d->get_topspeed());
		j.kv("pillars", (int)d->get_pillar());
	});

	vector_tpl<const tunnel_desc_t *> tunnels;
	tunnel_builder_t::get_all_desc(tunnels);
	catalog_add(cat, DESC_TUNNELS, tunnels, [](json_t &j, const tunnel_desc_t *d) {
		j.kv("waytype", waytype_name(d->get_waytype()));
		j.kv("speed", (int)d->get_topspeed());
	});

	json_t trees;
	trees.arr();
	const vector_tpl<const tree_desc_t *> &tree_list = tree_builder_t::get_all_desc();
	for (uint32 i = 0; i < tree_list.get_count(); i++) {
		if (const tree_desc_t *d = tree_list[i]) { // the list ends with NULL
			trees.obj().kv("i", (int)i).kv("name", d->get_name()).kv("climates", (int)d->get_allowed_climate_bits()).end_obj();
		}
	}
	trees.end_arr();
	cat.json[DESC_TREES].swap(trees.text());

	vector_tpl<const roadsign_desc_t *> signs;
	roadsign_t::get_all_desc(signs);
	catalog_add(cat, DESC_SIGNS, signs, [](json_t &j, const roadsign_desc_t *d) {
		j.kv("waytype", waytype_name(d->get_wtyp()));
		j.kv("flags", (int)d->get_flags());
		j.kv("traffic_light", d->is_traffic_light());
	});

	vector_tpl<const way_obj_desc_t *> wayobjs;
	for (auto const &i : wayobj_t::get_list()) {
		wayobjs.append(i.value);
	}
	catalog_add(cat, DESC_WAYOBJS, wayobjs, [](json_t &j, const way_obj_desc_t *d) {
		j.kv("waytype", waytype_name(d->get_wtyp()));
		j.kv("speed", (int)d->get_topspeed());
		j.kv("overhead", d->is_overhead_line());
	});

	vector_tpl<const goods_desc_t *> goods;
	for (uint16 i = 0; i < goods_manager_t::get_count(); i++) {
		goods.append(goods_manager_t::get_info(i));
	}
	catalog_add(cat, DESC_GOODS, goods, [](json_t &j, const goods_desc_t *d) {
		j.kv("color", (int)d->get_color_index());
		j.kv("catg", (int)d->get_catg());
	});

	vector_tpl<const citycar_desc_t *> citycars;
	private_car_t::get_all_desc(citycars);
	catalog_add(cat, DESC_CITYCARS, citycars, [](json_t &j, const citycar_desc_t *d) {
		j.kv("speed", (int)speed_to_kmh(d->get_topspeed()));
		write_timeline(j, d);
	});

	vector_tpl<const pedestrian_desc_t *> pedestrians;
	pedestrian_t::get_all_desc(pedestrians);
	catalog_add(cat, DESC_PEDESTRIANS, pedestrians, [](json_t &j, const pedestrian_desc_t *d) {
		write_timeline(j, d);
	});

	uint32 h = 2166136261u;
	for (int k = 0; k < DESC_KINDS; k++) {
		h = fnv1a(h, desc_kind_names[k], strlen(desc_kind_names[k]));
		h = fnv1a(h, cat.json[k].data(), cat.json[k].size());
	}
	cat.gen = h;
	cat.built = true;
	return cat;
}


static int catalog_index(const desc_catalog_t &cat, desc_kind_t kind, const void *desc)
{
	std::unordered_map<const void *, int>::const_iterator it = cat.index[kind].find(desc);
	return it == cat.index[kind].end() ? -1 : it->second;
}


/// the pak objects that scene3d and vehicles3d refer to by index
static const char *cmd_desc_list(const args_t &a, json_t &j)
{
	const uint64 start = time_us();
	uint32 kinds = (1u << DESC_KINDS) - 1;
	const std::string list = arg_str(a, "kinds");
	if (!list.empty()) {
		kinds = 0;
		size_t pos = 0;
		while (pos <= list.size()) {
			size_t end = list.find(',', pos);
			if (end == std::string::npos) {
				end = list.size();
			}
			const std::string name = list.substr(pos, end - pos);
			int k = 0;
			while (k < DESC_KINDS  &&  name != desc_kind_names[k]) {
				k++;
			}
			if (k == DESC_KINDS) {
				return make_error("unknown kind '%s' (buildings vehicles ways bridges tunnels trees signs wayobjs goods citycars pedestrians)", name.c_str());
			}
			kinds |= 1u << k;
			pos = end + 1;
		}
	}
	const desc_catalog_t &cat = get_desc_catalog();
	j.kv("pakset", env_t::pak_name.c_str());
	j.kv("gen", cat.gen);
	for (int k = 0; k < DESC_KINDS; k++) {
		if (kinds & (1u << k)) {
			j.key(desc_kind_names[k]).raw(cat.json[k]);
		}
	}
	j.kv("t_us", (sint64)(time_us() - start));
	return NULL;
}


/// object kinds of scene3d
enum scene_kind_t
{
	SCENE_WAY = 0, SCENE_BUILDING, SCENE_TREE, SCENE_BRIDGE, SCENE_TUNNEL, SCENE_SIGN, SCENE_WAYOBJ,
	SCENE_PILLAR, SCENE_POWERLINE, SCENE_FIELD, SCENE_GROUNDOBJ, SCENE_OTHER
};

/// one object of scene3d; the binary block stores the fields as columns in this order
struct scene_obj_t
{
	uint8 x, y;   ///< square inside the chunk
	sint8 z;      ///< height of the ground that carries the object
	uint8 kind;   ///< scene_kind_t
	sint16 desc;  ///< index in the desc_list list of the kind, -1 none
	uint16 a, b;  ///< meaning depends on the kind
	sint8 owner;  ///< player number, -1 nobody
};

#define SCENE_OBJ_BYTES 11
static const char scene_obj_layout[] = "x:u8,y:u8,z:i8,kind:u8,desc:i16,a:u16,b:u16,owner:i8";


/// the age classes of the tree images (tree_builder_t::get_tree_image)
static int tree_age_class(uint32 age)
{
	static const uint8 age_class[12] = { 0, 1, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4 };
	return age_class[min(age >> 6, 11u)];
}


/// appends the objects of a ground (moving objects are left out)
static void collect_scene_objects(std::vector<scene_obj_t> &out, const desc_catalog_t &cat, const grund_t *gr, int lx, int ly)
{
	// way flags: bit 0 on a bridge (also the ramp) or an elevated way, bit 1 tunnel portal, bits 8-15 way slope
	const int way_flags = (!gr->ist_karten_boden()  ||  gr->ist_bruecke() ? 1 : 0) | (gr->ist_tunnel() ? 2 : 0) | ((int)(uint8)gr->get_weg_hang() << 8);
	for (uint8 n = 0; n < gr->obj_count(); n++) {
		obj_t *obj = gr->obj_bei(n);
		int kind, desc = -1, a = 0, b = 0;
		switch (obj->get_typ()) {
			case obj_t::way: {
				const weg_t *w = static_cast<const weg_t *>(obj);
				kind = SCENE_WAY;
				desc = catalog_index(cat, DESC_WAYS, w->get_desc());
				a = w->get_ribi_unmasked();
				b = way_flags;
				break;
			}
			case obj_t::gebaeude:
			case obj_t::bahndepot:
			case obj_t::strassendepot:
			case obj_t::schiffdepot:
			case obj_t::airdepot:
			case obj_t::monoraildepot:
			case obj_t::tramdepot:
			case obj_t::maglevdepot:
			case obj_t::narrowgaugedepot: {
				const building_tile_desc_t *tile = static_cast<const gebaeude_t *>(obj)->get_tile();
				kind = SCENE_BUILDING;
				if (tile) {
					desc = catalog_index(cat, DESC_BUILDINGS, tile->get_desc());
					a = tile->get_layout();
					const koord off = tile->get_offset();
					b = off.x + 256 * off.y;
				}
				break;
			}
			case obj_t::baum: {
				const baum_t *tree = static_cast<const baum_t *>(obj);
				kind = SCENE_TREE;
				desc = tree->get_desc_id();
				a = tree_age_class(tree->get_age());
				break;
			}
			case obj_t::bruecke:
				kind = SCENE_BRIDGE;
				desc = catalog_index(cat, DESC_BRIDGES, static_cast<const bruecke_t *>(obj)->get_desc());
				a = gr->get_weg_ribi_unmasked(obj->get_waytype());
				break;
			case obj_t::tunnel:
				kind = SCENE_TUNNEL;
				desc = catalog_index(cat, DESC_TUNNELS, static_cast<const tunnel_t *>(obj)->get_desc());
				a = gr->get_weg_ribi_unmasked(obj->get_waytype());
				break;
			case obj_t::roadsign:
			case obj_t::signal: {
				roadsign_t *sign = static_cast<roadsign_t *>(obj);
				kind = SCENE_SIGN;
				desc = catalog_index(cat, DESC_SIGNS, sign->get_desc());
				a = sign->get_dir();
				b = (int)sign->get_state() | (obj->get_typ() == obj_t::signal ? 256 : 0);
				break;
			}
			case obj_t::wayobj: {
				const wayobj_t *wo = static_cast<const wayobj_t *>(obj);
				kind = SCENE_WAYOBJ;
				desc = catalog_index(cat, DESC_WAYOBJS, wo->get_desc());
				a = wo->get_dir();
				b = wo->get_desc()->get_waytype();
				break;
			}
			case obj_t::pillar:
				kind = SCENE_PILLAR;
				desc = catalog_index(cat, DESC_BRIDGES, static_cast<const pillar_t *>(obj)->get_desc());
				break;
			case obj_t::leitung:
			case obj_t::pumpe:
			case obj_t::senke: {
				leitung_t *line = static_cast<leitung_t *>(obj);
				kind = SCENE_POWERLINE;
				desc = catalog_index(cat, DESC_WAYS, line->get_desc());
				a = line->get_ribi();
				b = obj->get_typ() == obj_t::leitung ? 0 : obj->get_typ() == obj_t::pumpe ? 1 : 2;
				break;
			}
			case obj_t::field:
				kind = SCENE_FIELD;
				break;
			case obj_t::groundobj:
				kind = SCENE_GROUNDOBJ;
				break;
			case obj_t::label:
			case obj_t::crossing:
				kind = SCENE_OTHER;
				a = obj->get_typ();
				break;
			default:
				continue; // vehicles, pedestrians, city cars, animals, smoke, cursor
		}
		const scene_obj_t o = { (uint8)lx, (uint8)ly, gr->get_hoehe(), (uint8)kind, (sint16)desc, (uint16)a, (uint16)b, (sint8)owner_of(obj->get_owner_nr()) };
		out.push_back(o);
	}
}


/// the objects as columns of little endian integers (scene_obj_layout)
static void pack_scene_objects(const std::vector<scene_obj_t> &objs, std::vector<uint8> &out)
{
	const size_t n = objs.size();
	out.resize(n * SCENE_OBJ_BYTES);
	uint8 *const x = out.data(), *const y = x + n, *const z = y + n, *const kind = z + n;
	uint8 *const desc = kind + n, *const a = desc + 2 * n, *const b = a + 2 * n, *const owner = b + 2 * n;
	for (size_t i = 0; i < n; i++) {
		const scene_obj_t &o = objs[i];
		x[i] = o.x;
		y[i] = o.y;
		z[i] = (uint8)o.z;
		kind[i] = o.kind;
		desc[2 * i] = (uint8)((uint16)o.desc & 0xFF);
		desc[2 * i + 1] = (uint8)((uint16)o.desc >> 8);
		a[2 * i] = (uint8)(o.a & 0xFF);
		a[2 * i + 1] = (uint8)(o.a >> 8);
		b[2 * i] = (uint8)(o.b & 0xFF);
		b[2 * i + 1] = (uint8)(o.b >> 8);
		owner[i] = (uint8)o.owner;
	}
}


static bool append_zlib_base64(std::string &out, const std::vector<uint8> &data, int level)
{
	uLongf packed_len = compressBound((uLong)data.size());
	std::vector<uint8> packed(packed_len);
	if (compress2(packed.data(), &packed_len, data.data(), (uLong)data.size(), level) != Z_OK) {
		return false;
	}
	append_base64(out, packed.data(), packed_len);
	return true;
}


/// writes "key":"<zlib+base64 of data>"
static bool write_zlib_block(json_t &j, const char *key, const std::vector<uint8> &data, int level)
{
	std::string encoded;
	if (!append_zlib_base64(encoded, data, level)) {
		return false;
	}
	j.key(key).safe_str(encoded.c_str(), encoded.size());
	return true;
}


/**
 * One chunk of the map for the 3D view: corner heights and ground types of the surface and the
 * objects of all grounds except tunnel interiors, as zlib+base64 blocks (objs=json: rows of numbers).
 * A heavy command: at most one runs per poll (see execute_requests).
 */
static const char *cmd_scene3d(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const sint64 size = arg_int(a, "size", 64);
	if (size != 16  &&  size != 32  &&  size != 64) {
		return "size must be 16, 32 or 64";
	}
	if (!has_arg(a, "cx")  ||  !has_arg(a, "cy")) {
		return "missing chunk coordinates cx,cy";
	}
	const sint64 cx = arg_int(a, "cx", 0), cy = arg_int(a, "cy", 0);
	const koord map_size = welt->get_size();
	if (cx < 0  ||  cy < 0  ||  cx >= map_size.x  ||  cy >= map_size.y  ||  cx * size >= map_size.x  ||  cy * size >= map_size.y) {
		return "chunk is outside of the map";
	}
	const std::string objs_format = arg_str(a, "objs", "bin");
	if (objs_format != "bin"  &&  objs_format != "json") {
		return "objs must be bin or json";
	}
	// zlib level 4 compresses the object columns almost as well as 6 in less than half the time
	const int level = (int)clamp<sint64>(arg_int(a, "level", 4), 1, 9);

	const uint64 start = time_us();
	const int x0 = (int)(cx * size), y0 = (int)(cy * size);
	const int w = (int)std::min<sint64>(size, map_size.x - x0), h = (int)std::min<sint64>(size, map_size.y - y0);
	map_tracking_start();
	// the chunk lies in one tracking cell: scan it now, so that its first scan does not count as a change after rev
	map_tracking_scan_at(koord((sint16)x0, (sint16)y0));
	const desc_catalog_t &cat = get_desc_catalog();

	std::vector<uint8> corners((size_t)w * h * 4), ground((size_t)w * h);
	std::vector<scene_obj_t> objs;
	objs.reserve(4096);
	size_t i = 0;
	for (int ly = 0; ly < h; ly++) {
		for (int lx = 0; lx < w; lx++, i++) {
			const planquadrat_t *plan = welt->access_nocheck((sint16)(x0 + lx), (sint16)(y0 + ly));
			const grund_t *gr = plan->get_kartenboden();
			const sint8 z = gr->get_hoehe();
			const slope_t::type slope = gr->get_grund_hang();
			corners[i * 4 + 0] = (uint8)(sint8)(z + corner_sw(slope));
			corners[i * 4 + 1] = (uint8)(sint8)(z + corner_se(slope));
			corners[i * 4 + 2] = (uint8)(sint8)(z + corner_ne(slope));
			corners[i * 4 + 3] = (uint8)(sint8)(z + corner_nw(slope));
			int type;
			switch (gr->get_typ()) {
				case grund_t::boden:         type = 0; break;
				case grund_t::wasser:        type = 1; break;
				case grund_t::fundament:     type = 2; break;
				case grund_t::tunnelboden:   type = 3; break;
				case grund_t::brueckenboden: type = 4; break;
				default:                     type = 5; break;
			}
			if (gr->is_water()) {
				type = 1;
			}
			ground[i] = (uint8)(type | (plan->get_climate() << 4));

			for (unsigned g = 0; g < plan->get_boden_count(); g++) {
				const grund_t *gnd = plan->get_boden_bei(g);
				if (gnd->ist_im_tunnel()  ||  (!gnd->ist_karten_boden()  &&  gnd->is_dummy_ground())) {
					continue;
				}
				collect_scene_objects(objs, cat, gnd, lx, ly);
			}
		}
	}

	j.kv("cx", (int)cx).kv("cy", (int)cy).kv("size", (int)size);
	j.kv("x0", x0).kv("y0", y0).kv("w", w).kv("h", h);
	j.kv("rev", map_gen);
	j.kv("desc_gen", cat.gen);
	j.kv("water", (int)welt->get_groundwater());
	j.kv("season", (int)welt->get_season());
	j.kv("snowline", (int)welt->get_snowline());
	j.kv("rotation", (int)welt->get_settings().get_rotation());
	j.kv("encoding", "zlib+base64");
	if (!write_zlib_block(j, "corners", corners, level)  ||  !write_zlib_block(j, "ground", ground, level)) {
		return "compression failed";
	}
	j.kv("count", (uint32)objs.size());
	if (objs_format == "json") {
		j.key("objs").arr();
		for (const scene_obj_t &o : objs) {
			const int row[8] = { o.x, o.y, o.z, o.kind, o.desc, o.a, o.b, o.owner };
			j.int_row(row, 8);
		}
		j.end_arr();
	}
	else {
		j.kv("objs_layout", scene_obj_layout);
		std::vector<uint8> packed;
		pack_scene_objects(objs, packed);
		if (!write_zlib_block(j, "objs", packed, level)) {
			return "compression failed";
		}
	}
	j.kv("t_us", (sint64)(time_us() - start));
	return NULL;
}

/// at most this many samples per heights request (256x256 squares at step 1): about 0.5-1 ms
#define MAX_HEIGHT_SAMPLES (257*257)


/// parses the inclusive region x1 y1 x2 y2 (default the whole map) and clips it to the map
static const char *parse_map_region(const args_t &a, koord map_size, sint64 &x1, sint64 &y1, sint64 &x2, sint64 &y2)
{
	x1 = arg_int(a, "x1", 0);
	y1 = arg_int(a, "y1", 0);
	x2 = arg_int(a, "x2", map_size.x - 1);
	y2 = arg_int(a, "y2", map_size.y - 1);
	if (x1 > x2) {
		std::swap(x1, x2);
	}
	if (y1 > y2) {
		std::swap(y1, y2);
	}
	x1 = std::max<sint64>(x1, 0);
	y1 = std::max<sint64>(y1, 0);
	x2 = std::min<sint64>(x2, map_size.x - 1);
	y2 = std::min<sint64>(y2, map_size.y - 1);
	if (x1 > x2  ||  y1 > y2) {
		return "region is outside of the map";
	}
	return NULL;
}


/**
 * Terrain heights for a far terrain and a whole map overview: the heights of every step-th point of
 * the height grid (the north-west corners of the squares, as the game keeps them for terraforming)
 * and the water height there, int8 each, zlib+base64. A heavy command.
 */
static const char *cmd_heights(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const koord map_size = welt->get_size();
	const sint64 step = arg_int(a, "step", 1);
	if (step != 1  &&  step != 2  &&  step != 4  &&  step != 8  &&  step != 16) {
		return "step must be 1, 2, 4, 8 or 16";
	}
	sint64 x1, y1, x2, y2;
	if (const char *err = parse_map_region(a, map_size, x1, y1, x2, y2)) {
		return err;
	}
	// the points run from the north-west corner of (x1,y1) to the south-east corner of (x2,y2)
	const sint64 w = (x2 + 1 - x1 + step - 1) / step + 1, h = (y2 + 1 - y1 + step - 1) / step + 1;
	if (w * h > MAX_HEIGHT_SAMPLES) {
		return "too many samples (at most 66049 per request): use a larger step or a smaller region";
	}
	const int level = (int)clamp<sint64>(arg_int(a, "level", 1), 1, 9);

	const uint64 start = time_us();
	map_tracking_start();
	std::vector<uint8> heights((size_t)(w * h)), water((size_t)(w * h));
	sint8 lo = 127, hi = -128;
	size_t i = 0;
	for (sint64 sy = 0; sy < h; sy++) {
		const sint16 y = (sint16)std::min<sint64>(y1 + sy * step, y2 + 1);
		const sint16 wy = (sint16)std::min<sint64>(y, map_size.y - 1);
		for (sint64 sx = 0; sx < w; sx++, i++) {
			const sint16 x = (sint16)std::min<sint64>(x1 + sx * step, x2 + 1);
			const sint8 z = welt->lookup_hgt_nocheck(x, y);
			heights[i] = (uint8)z;
			water[i] = (uint8)welt->get_water_hgt_nocheck((sint16)std::min<sint64>(x, map_size.x - 1), wy);
			lo = std::min(lo, z);
			hi = std::max(hi, z);
		}
	}

	j.kv("x1", (int)x1).kv("y1", (int)y1).kv("x2", (int)x2).kv("y2", (int)y2);
	j.kv("step", (int)step).kv("w", (int)w).kv("h", (int)h);
	j.kv("rev", map_gen);
	j.kv("water", (int)welt->get_groundwater());
	j.kv("min", (int)lo).kv("max", (int)hi);
	j.kv("encoding", "zlib+base64");
	if (!write_zlib_block(j, "heights", heights, level)  ||  !write_zlib_block(j, "water_heights", water, level)) {
		return "compression failed";
	}
	j.kv("t_us", (sint64)(time_us() - start));
	return NULL;
}


/// one vehicle of vehicles3d; the binary block stores the fields as columns, 16 bit columns first
struct vehicle_row_t
{
	uint16 cnv;        ///< convoy id, 0 for city cars and pedestrians
	sint16 desc;       ///< index in the desc_list list of the kind
	uint16 x, y;       ///< square
	sint16 ox, oy;     ///< position in the square relative to its centre, 1/256 square
	sint16 zoff;       ///< height above z, 1/16 height level (slopes, flight altitude)
	uint16 speed;      ///< yards per tick (steps per tick = speed / 4096)
	uint16 flags;      ///< VEH_*
	uint8 idx;         ///< index in the convoy
	uint8 kind;        ///< VEH_KIND_*
	sint8 z;           ///< height of the square's ground
	uint8 dir;         ///< direction (ribi)
	uint8 steps, steps_next;
	sint8 nx, ny, nz;  ///< pos_next - pos, -128 when invalid or farther
	sint8 owner;       ///< player number, -1 nobody
};

#define VEHICLE_ROW_BYTES 28
static const char vehicle_row_layout[] =
	"cnv:u16,desc:i16,x:u16,y:u16,ox:i16,oy:i16,zoff:i16,speed:u16,flags:u16,"
	"idx:u8,kind:u8,z:i8,dir:u8,steps:u8,steps_next:u8,nx:i8,ny:i8,nz:i8,owner:i8";

enum { VEH_KIND_CONVOY = 0, VEH_KIND_CITYCAR = 1, VEH_KIND_PEDESTRIAN = 2 };

enum
{
	VEH_LEADING   = 1 << 0,  ///< first vehicle of its convoy (always set for city cars and pedestrians)
	VEH_LAST      = 1 << 1,  ///< last vehicle of its convoy (likewise)
	VEH_LEAVING   = 1 << 2,  ///< the convoy leaves a depot
	VEH_ENTERING  = 1 << 3,  ///< the convoy drives into a depot
	VEH_LOADING   = 1 << 4,  ///< the convoy loads at a stop
	VEH_WAITING   = 1 << 5,  ///< the convoy waits (for a free way, to start, for a route)
	VEH_TUNNEL    = 1 << 6,  ///< inside a tunnel (not on a portal)
	VEH_HIDDEN    = 1 << 7,  ///< the game draws no image (e.g. half way into a tunnel portal)
	VEH_FLYING    = 1 << 8,  ///< an aircraft in the air
	VEH_OVERTAKE  = 1 << 9   ///< overtaking (road vehicles and city cars)
};


static sint8 clamp_delta(int d)
{
	return (sint8)(d < -127  ||  d > 127 ? -128 : d);
}


/// the fields of a row that every moving thing has
static void fill_vehicle_row(vehicle_row_t &r, const vehicle_base_t *v, const grund_t *gr)
{
	const koord3d pos = v->get_pos();
	r.x = (uint16)pos.x;
	r.y = (uint16)pos.y;
	r.z = pos.z;
	r.dir = (uint8)v->get_direction();
	r.steps = v->get_steps();
	r.steps_next = v->get_steps_next();
	// the drawing offset at a raster width of 256 (screen x = (x-y)*128, y = (x+y)*64) back in squares
	const sint16 raster = 256;
	int sx = tile_raster_scale_x(v->get_xoff(), raster), sy = tile_raster_scale_y(v->get_yoff(), raster);
	v->get_screen_offset(sx, sy, raster);
	const sint16 hoff = v->get_hoff(raster);
	sy -= hoff / (4 * 16);
	r.ox = (sint16)clamp(sx + 2 * sy, -32767, 32767);
	r.oy = (sint16)clamp(2 * sy - sx, -32767, 32767);
	// get_hoff(256) = -TILE_HEIGHT_STEP * 256 * height in levels
	r.zoff = (sint16)(-hoff * 16 / (TILE_HEIGHT_STEP * 256));
	const koord3d next = v->get_pos_next();
	if (next == koord3d::invalid) {
		r.nx = r.ny = r.nz = -128;
	}
	else {
		r.nx = clamp_delta(next.x - pos.x);
		r.ny = clamp_delta(next.y - pos.y);
		r.nz = clamp_delta(next.z - pos.z);
	}
	r.owner = (sint8)owner_of(v->get_owner_nr());
	r.flags = 0;
	if (gr  &&  gr->ist_tunnel()  &&  !gr->ist_karten_boden()) {
		r.flags |= VEH_TUNNEL;
	}
	if (v->get_image() == IMG_EMPTY) {
		r.flags |= VEH_HIDDEN;
	}
}


/// the rows as columns of little endian integers (vehicle_row_layout)
static void pack_vehicle_rows(const std::vector<vehicle_row_t> &rows, std::vector<uint8> &out)
{
	const size_t n = rows.size();
	out.resize(n * VEHICLE_ROW_BYTES);
	uint8 *col16[9], *col8[10];
	for (int c = 0; c < 9; c++) {
		col16[c] = out.data() + 2 * n * c;
	}
	for (int c = 0; c < 10; c++) {
		col8[c] = out.data() + 18 * n + n * c;
	}
	for (size_t i = 0; i < n; i++) {
		const vehicle_row_t &r = rows[i];
		const uint16 v16[9] = { r.cnv, (uint16)r.desc, r.x, r.y, (uint16)r.ox, (uint16)r.oy, (uint16)r.zoff, r.speed, r.flags };
		for (int c = 0; c < 9; c++) {
			col16[c][2 * i] = (uint8)(v16[c] & 0xFF);
			col16[c][2 * i + 1] = (uint8)(v16[c] >> 8);
		}
		const uint8 v8[10] = { r.idx, r.kind, (uint8)r.z, r.dir, r.steps, r.steps_next, (uint8)r.nx, (uint8)r.ny, (uint8)r.nz, (uint8)r.owner };
		for (int c = 0; c < 10; c++) {
			col8[c][i] = v8[c];
		}
	}
}


/// at most this many squares are searched for city cars and pedestrians (vehicles3d extras=1)
#define MAX_EXTRAS_SQUARES (256*256)


/**
 * The moving things in a region for the 3D view: every vehicle of the convoys on the map, with
 * extras=1 also city cars and pedestrians, with what is needed to move them smoothly between
 * samples. Convoy vehicles come from the convoy list (cheap for any region); city cars and
 * pedestrians need a search of the region's squares, so a request with extras=1 is heavy
 * (see is_heavy_request).
 */
static const char *cmd_vehicles3d(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const koord map_size = welt->get_size();
	sint64 x1, y1, x2, y2;
	if (const char *err = parse_map_region(a, map_size, x1, y1, x2, y2)) {
		return err;
	}
	const bool extras = arg_bool(a, "extras", false);
	if (extras  &&  (x2 - x1 + 1) * (y2 - y1 + 1) > MAX_EXTRAS_SQUARES) {
		return "extras=1: region too large (at most 65536 squares)";
	}
	const std::string objs_format = arg_str(a, "objs", "bin");
	if (objs_format != "bin"  &&  objs_format != "json") {
		return "objs must be bin or json";
	}
	// the samples are short-lived: the fastest zlib level, only 7 % larger than level 4
	const int level = (int)clamp<sint64>(arg_int(a, "level", 1), 1, 9);

	const uint64 start = time_us();
	const desc_catalog_t &cat = get_desc_catalog();
	const vehicle_desc_t *last_desc = NULL; // the vehicles of a convoy often share their type
	int last_index = -1;
	std::vector<vehicle_row_t> rows;
	rows.reserve(1024);
	for (convoihandle_t cnv : welt->convoys()) {
		if (!cnv.is_bound()) {
			continue;
		}
		const int state = cnv->get_state();
		uint16 cnv_flags = 0;
		switch (state) {
			case convoi_t::LEAVING_DEPOT:  cnv_flags = VEH_LEAVING; break;
			case convoi_t::ENTERING_DEPOT: cnv_flags = VEH_ENTERING; break;
			case convoi_t::LOADING:        cnv_flags = VEH_LOADING; break;
			case convoi_t::WAITING_FOR_CLEARANCE:
			case convoi_t::WAITING_FOR_CLEARANCE_ONE_MONTH:
			case convoi_t::WAITING_FOR_CLEARANCE_TWO_MONTHS:
			case convoi_t::CAN_START:
			case convoi_t::CAN_START_ONE_MONTH:
			case convoi_t::CAN_START_TWO_MONTHS:
			case convoi_t::NO_ROUTE:
			case convoi_t::ROUTING_1:      cnv_flags = VEH_WAITING; break;
			default: break;
		}
		const uint16 speed = (uint16)clamp<sint32>(cnv->get_akt_speed(), 0, 65535);
		const uint8 count = cnv->get_vehicle_count();
		for (uint8 n = 0; n < count; n++) {
			vehicle_t *v = cnv->get_vehicle(n);
			if (v == NULL  ||  v->get_flag(obj_t::not_on_map)) {
				continue; // in a depot
			}
			const koord3d pos = v->get_pos();
			if (pos.x < x1  ||  pos.x > x2  ||  pos.y < y1  ||  pos.y > y2) {
				continue;
			}
			vehicle_row_t r;
			fill_vehicle_row(r, v, welt->lookup(pos));
			r.cnv = cnv.get_id();
			r.idx = n;
			r.kind = VEH_KIND_CONVOY;
			if (v->get_desc() != last_desc) {
				last_desc = v->get_desc();
				last_index = catalog_index(cat, DESC_VEHICLES, last_desc);
			}
			r.desc = (sint16)last_index;
			r.speed = speed;
			r.flags |= cnv_flags;
			if (v->is_leading()) {
				r.flags |= VEH_LEADING;
			}
			if (v->is_last()) {
				r.flags |= VEH_LAST;
			}
			if (v->get_typ() == obj_t::air_vehicle) {
				const air_vehicle_t *air = static_cast<const air_vehicle_t *>(v);
				if (air->is_flying()) {
					r.flags |= VEH_FLYING;
				}
				// flying height in pixels at raster 64 (TILE_HEIGHT_STEP per level)
				const int flying = air->get_flyingheight() + air->get_hoff() + 2;
				r.zoff = (sint16)clamp(r.zoff + flying * 16 / TILE_HEIGHT_STEP, -32767, 32767);
			}
			if (v->get_waytype() == road_wt  &&  cnv->is_overtaking()) {
				r.flags |= VEH_OVERTAKE;
			}
			rows.push_back(r);
		}
	}
	const uint32 convoy_rows = (uint32)rows.size();

	if (extras) {
		for (sint64 y = y1; y <= y2; y++) {
			for (sint64 x = x1; x <= x2; x++) {
				const planquadrat_t *plan = welt->access_nocheck((sint16)x, (sint16)y);
				for (unsigned g = 0; g < plan->get_boden_count(); g++) {
					const grund_t *gr = plan->get_boden_bei(g);
					if (!gr->hat_wege()) {
						continue; // city cars and pedestrians only use roads
					}
					for (uint8 n = 0; n < gr->obj_count(); n++) {
						const obj_t *obj = gr->obj_bei(n);
						const obj_t::typ typ = obj->get_typ();
						if (typ != obj_t::road_user  &&  typ != obj_t::pedestrian) {
							continue;
						}
						vehicle_row_t r;
						fill_vehicle_row(r, static_cast<const vehicle_base_t *>(obj), gr);
						r.cnv = 0;
						r.idx = 0;
						r.flags |= VEH_LEADING | VEH_LAST;
						if (typ == obj_t::road_user) {
							const private_car_t *car = static_cast<const private_car_t *>(obj);
							r.kind = VEH_KIND_CITYCAR;
							r.desc = (sint16)catalog_index(cat, DESC_CITYCARS, car->get_desc());
							r.speed = car->get_current_speed();
							if (car->is_overtaking()) {
								r.flags |= VEH_OVERTAKE;
							}
						}
						else {
							r.kind = VEH_KIND_PEDESTRIAN;
							r.desc = (sint16)catalog_index(cat, DESC_PEDESTRIANS, static_cast<const pedestrian_t *>(obj)->get_desc());
							r.speed = 128; // pedestrian_t::sync_step
						}
						rows.push_back(r);
					}
				}
			}
		}
	}

	j.kv("x1", (int)x1).kv("y1", (int)y1).kv("x2", (int)x2).kv("y2", (int)y2);
	j.kv("ticks", (sint64)welt->get_ticks());
	j.kv("paused", welt->is_paused()).kv("ff", fast_forward_on()).kv("mult", (int)welt->get_time_multiplier());
	j.kv("drive_left", welt->get_settings().is_drive_left());
	j.kv("diag_steps", (int)vehicle_base_t::get_diagonal_vehicle_steps_per_tile());
	j.kv("desc_gen", cat.gen);
	j.kv("count", (uint32)rows.size()).kv("convoy_rows", convoy_rows);
	if (objs_format == "json") {
		j.key("objs").arr();
		for (const vehicle_row_t &r : rows) {
			const int row[19] = { r.cnv, r.desc, r.x, r.y, r.ox, r.oy, r.zoff, r.speed, r.flags,
				r.idx, r.kind, r.z, r.dir, r.steps, r.steps_next, r.nx, r.ny, r.nz, r.owner };
			j.int_row(row, 19);
		}
		j.end_arr();
	}
	else {
		j.kv("encoding", "zlib+base64");
		j.kv("objs_layout", vehicle_row_layout);
		std::vector<uint8> packed;
		pack_vehicle_rows(rows, packed);
		if (!write_zlib_block(j, "objs", packed, level)) {
			return "compression failed";
		}
	}
	j.kv("t_us", (sint64)(time_us() - start));
	return NULL;
}


static uint32 mix32(uint32 x)
{
	x ^= x >> 16;
	x *= 0x7feb352dU;
	x ^= x >> 15;
	x *= 0x846ca68bU;
	x ^= x >> 16;
	return x;
}


/**
 * Small status for frequent polling: time, speed, active player, newest message, object counts
 * and change counters (rev.objects changes when convoys, lines, stations or cities are added or
 * removed; world.gen changes when a world is loaded or created).
 */
static const char *cmd_poll(const args_t &, json_t &j)
{
	karte_t *welt = world();
	const uint32 ticks = welt->get_ticks();
	const uint32 per_month = welt->ticks_per_world_month;
	double progress = per_month ? 1.0 - (double)(uint32)(welt->get_next_month_ticks() - ticks) / per_month : 0.0;
	progress = std::floor(clamp(progress, 0.0, 1.0) * 1000.0 + 0.5) / 1000.0;

	j.kv("ticks", (sint64)ticks);
	write_date(j, "date", welt->get_current_month());
	j.kv("month_progress", progress);
	j.kv("ticks_per_month", per_month);
	j.kv("paused", welt->is_paused());
	j.kv("ff", fast_forward_on());
	j.kv("mult", (int)welt->get_time_multiplier());

	player_t *active = welt->get_active_player();
	j.key("player");
	if (active) {
		j.obj();
		j.kv("nr", (int)active->get_player_nr());
		j.kv("name", active->get_name());
		j.kv("cash", money(active->get_finance()->get_account_balance()));
		j.end_obj();
	}
	else {
		j.null();
	}
	j.kv("msg_seq", (uint32)welt->get_message()->get_list().get_count());

	// object counts and an order independent checksum of the object ids
	uint32 objects = 0;
	for (convoihandle_t cnv : welt->convoys()) {
		objects += mix32(0x10000u | cnv.get_id());
	}
	uint32 lines = 0, players = 0;
	for (int i = 0; i < MAX_PLAYER_COUNT; i++) {
		if (player_t *player = welt->get_player(i)) {
			players++;
			for (linehandle_t line : player->simlinemgmt.get_line_list()) {
				objects += mix32(0x20000u | line.get_id());
				lines++;
			}
		}
	}
	const vector_tpl<halthandle_t> &halts = haltestelle_t::get_alle_haltestellen();
	for (halthandle_t halt : halts) {
		objects += mix32(0x30000u | halt.get_id());
	}
	const uint32 cities = welt->get_cities().get_count();
	objects = mix32(objects ^ mix32(0x40000u | cities));

	j.key("counts").obj();
	j.kv("convoys", (uint32)welt->convoys().get_count());
	j.kv("lines", lines);
	j.kv("halts", (uint32)halts.get_count());
	j.kv("factories", (uint32)welt->get_fab_list().get_count());
	j.kv("cities", cities);
	j.kv("players", players);
	j.end_obj();

	// the map gen also notices other worlds and rotations while the map is not tracked
	map_tracking_validate();
	if (map_track.active) {
		map_track.last_use = dr_time();
	}

	j.key("rev").obj();
	j.kv("objects", objects);
	j.kv("schedules", (int)welt->get_schedule_counter());
	j.kv("map", map_gen);
	j.end_obj();

	j.key("world").obj();
	j.kv("gen", (uint32)remote_control_world_generation);
	j.kv("size_x", (int)welt->get_size().x);
	j.kv("size_y", (int)welt->get_size().y);
	j.kv("rotation", (int)welt->get_settings().get_rotation());
	j.end_obj();
	return NULL;
}


// ---------------------------------------------------------------------------
// toolbars and tool visibility
// ---------------------------------------------------------------------------

/// reference of a tool as written in menuconf.tab, e.g. "simple_tool[5]"
static std::string tool_ref(uint16 id)
{
	char buf[32];
	const unsigned nr = id & 0x0FFF;
	if (id & TOOLBAR_TOOL) {
		sprintf(buf, "toolbar[%u]", nr);
	}
	else if (id & DIALOGE_TOOL) {
		sprintf(buf, "dialog_tool[%u]", nr);
	}
	else if (id & SIMPLE_TOOL) {
		sprintf(buf, "simple_tool[%u]", nr);
	}
	else if (id & GENERAL_TOOL) {
		sprintf(buf, "general_tool[%u]", nr);
	}
	else {
		sprintf(buf, "%u", (unsigned)id);
	}
	return buf;
}


/// "simple_tool[5]" or a name like "TOOL_SWITCH_PLAYER"; false if there is no such tool
static bool parse_tool_ref(std::string s, uint16 &id)
{
	static const struct { const char *prefix; uint16 flag; uint32 count; } kinds[] = {
		{ "general_tool[", GENERAL_TOOL, GENERAL_TOOL_COUNT },
		{ "simple_tool[",  SIMPLE_TOOL,  SIMPLE_TOOL_COUNT },
		{ "dialog_tool[",  DIALOGE_TOOL, DIALOGE_TOOL_COUNT },
		{ "toolbar[",      TOOLBAR_TOOL, 0 }
	};
	for (auto const &k : kinds) {
		const size_t len = strlen(k.prefix);
		if (s.compare(0, len, k.prefix) == 0) {
			char *end = NULL;
			const long nr = strtol(s.c_str() + len, &end, 10);
			const uint32 count = k.flag == TOOLBAR_TOOL ? tool_t::toolbar_tool.get_count() : k.count;
			if (end == s.c_str() + len  ||  strcmp(end, "]") != 0  ||  nr < 0  ||  (uint32)nr >= count) {
				return false;
			}
			id = (uint16)(k.flag | nr);
			return true;
		}
	}
	std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)toupper(c); });
	for (auto const &k : kinds) {
		for (uint32 nr = 0; nr < k.count; nr++) {
			if (s == tool_t::id_to_string((uint16)(k.flag | nr))) {
				id = (uint16)(k.flag | nr);
				return true;
			}
		}
	}
	return false;
}


static const char *visibility_name(uint8 v)
{
	return v == tool_t::VISIBILITY_SHOW ? "show" : (v == tool_t::VISIBILITY_HIDE ? "hide" : "default");
}


static bool contains_nocase(const char *text, const std::string &part)
{
	if (text == NULL) {
		return false;
	}
	std::string t = text, p = part;
	std::transform(t.begin(), t.end(), t.begin(), [](unsigned char c) { return (char)tolower(c); });
	std::transform(p.begin(), p.end(), p.begin(), [](unsigned char c) { return (char)tolower(c); });
	return t.find(p) != std::string::npos;
}


static void write_tool_ids(json_t &j, uint16 id, sint16 wt, const char *param)
{
	j.kv("ref", tool_ref(id).c_str());
	if ((id & TOOLBAR_TOOL) == 0) {
		j.kv("name", tool_t::id_to_string(id));
	}
	if (wt != invalid_wt  &&  wt != ignore_wt) {
		j.kv("waytype", (int)wt);
	}
	if (param  &&  *param) {
		j.kv("param", param);
	}
}


static void write_tool_entry(json_t &j, tool_t *w, player_t *player, const char *reason)
{
	const char *param = w->get_default_param();
	j.obj();
	write_tool_ids(j, w->get_id(), w->get_waytype(), param);
	const char *tip = w->get_tooltip(player);
	j.kv("tooltip", tip ? tip : "");
	const uint8 rule = tool_t::get_visibility(w->get_id(), w->get_waytype(), param);
	if (rule != tool_t::VISIBILITY_DEFAULT) {
		j.kv("rule", visibility_name(rule));
	}
	if (reason) {
		j.kv("reason", reason);
	}
	else if (!w->enabled) {
		j.kv("enabled", false);
	}
	j.end_obj();
}


/// why a configured tool is not in its toolbar (same checks as toolbar_t::update)
static const char *tool_hidden_reason(tool_t *w, player_t *player)
{
	const char *param = w->get_default_param();
	if (tool_t::get_visibility(w->get_id(), w->get_waytype(), param) == tool_t::VISIBILITY_HIDE) {
		return "hidden by rule";
	}
	scenario_t *scen = world()->get_scenario();
	if (scen->is_scripted()  &&  !scen->is_tool_allowed(player, w->get_id(), w->get_waytype(), param)) {
		return "forbidden by scenario";
	}
	if (!check_tool_availability(w)) {
		return "not available (timeline)";
	}
	return (w->get_id() & TOOLBAR_TOOL) ? "no tools in it" : "not shown";
}


/// meta tools like ways(16,0) fill a toolbar with one general tool for one waytype
static bool meta_tool_target(const char *param, uint16 &id, sint16 &wt)
{
	static const struct { const char *prefix; uint16 tool; } metas[] = {
		{ "ways(",    TOOL_BUILD_WAY },
		{ "bridges(", TOOL_BUILD_BRIDGE },
		{ "tunnels(", TOOL_BUILD_TUNNEL },
		{ "signs(",   TOOL_BUILD_ROADSIGN },
		{ "wayobjs(", TOOL_BUILD_WAYOBJ }
	};
	for (auto const &m : metas) {
		if (const char *c = strstart(param, m.prefix)) {
			id = (uint16)(m.tool | GENERAL_TOOL);
			wt = (sint16)atoi(c);
			return true;
		}
	}
	return false;
}


static void write_visibility_rules(json_t &j)
{
	j.key("rules").arr();
	for (tool_t::visibility_rule_t const &r : tool_t::get_visibility_rules()) {
		j.obj();
		write_tool_ids(j, r.id, r.wt, r.param.c_str());
		j.kv("visibility", visibility_name(r.visibility));
		j.end_obj();
	}
	j.end_arr();
}


/**
 * The toolbars with the tools they show and the configured tools they do not show, with the reason.
 * toolbar=<index or part of the name/title> limits the list to matching toolbars.
 */
static const char *cmd_toolbars(const args_t &a, json_t &j)
{
	player_t *player = world()->get_active_player();
	scenario_t *scen = world()->get_scenario();
	const std::string filter = arg_str(a, "toolbar");
	char *end = NULL;
	const long filter_nr = filter.empty() ? -1 : strtol(filter.c_str(), &end, 10);
	const bool filter_by_index = !filter.empty()  &&  *end == 0;

	j.key("toolbars").arr();
	for (uint32 t = 0; t < tool_t::toolbar_tool.get_count(); t++) {
		toolbar_t *tb = tool_t::toolbar_tool[t];
		const char *name = tb->get_default_param();
		const char *title = t == 0 ? "main menu" : tb->get_tooltip(player);
		if (filter_by_index ? filter_nr != (long)t : (!filter.empty()  &&  !contains_nocase(name, filter)  &&  !contains_nocase(title, filter))) {
			continue;
		}
		tool_selector_t *sel = tb->get_tool_selector();
		j.obj();
		j.kv("ref", tool_ref(tb->get_id()).c_str());
		j.kv("name", name ? name : "");
		j.kv("title", title ? title : "");
		j.kv("open", t == 0  ||  tb->is_selected());
		j.key("tools").arr();
		for (uint32 i = 0; sel  &&  i < sel->get_tool_count(); i++) {
			if (sel->get_tool(i) != tool_t::dummy) {
				write_tool_entry(j, sel->get_tool(i), player, NULL);
			}
		}
		j.end_arr();
		j.key("hidden").arr();
		for (tool_t *w : tb->get_tools()) {
			const char *param = w->get_default_param();
			if (w->command_key == 1  &&  w->get_icon(player) == IMG_EMPTY) {
				// meta tool: the whole group is missing if the scenario forbids the tool for this waytype
				uint16 id;
				sint16 wt;
				if (param  &&  meta_tool_target(param, id, wt)  &&  scen->is_scripted()  &&  !scen->is_tool_allowed(player, id, wt)) {
					j.obj();
					write_tool_ids(j, id, wt, NULL);
					j.kv("meta", param);
					const uint8 rule = tool_t::get_visibility(id, wt, NULL);
					if (rule != tool_t::VISIBILITY_DEFAULT) {
						j.kv("rule", visibility_name(rule));
					}
					j.kv("reason", "forbidden by scenario");
					j.end_obj();
				}
				continue;
			}
			if (w->get_icon(player) == IMG_EMPTY  &&  (w->get_id() & TOOLBAR_TOOL) == 0) {
				continue; // keyboard shortcut only
			}
			bool shown = false;
			for (uint32 i = 0; sel  &&  i < sel->get_tool_count()  &&  !shown; i++) {
				shown = sel->get_tool(i) == w;
			}
			if (!shown) {
				write_tool_entry(j, w, player, tool_hidden_reason(w, player));
			}
		}
		j.end_arr();
		j.end_obj();
	}
	j.end_arr();
	write_visibility_rules(j);
	return NULL;
}


/**
 * Sets a visibility rule: tool=<ref or name> visibility=show|hide|default [waytype=<nr>] [param=<text>],
 * or clear=1 removes all rules. Always returns the rules.
 */
static const char *cmd_tool_visibility(const args_t &a, json_t &j)
{
	if (arg_bool(a, "clear", false)) {
		while (tool_t::get_visibility_rules().get_count() > 0) {
			const tool_t::visibility_rule_t r = tool_t::get_visibility_rules()[0];
			tool_t::set_visibility(r.id, r.wt, r.param.c_str(), tool_t::VISIBILITY_DEFAULT);
		}
		tool_t::update_toolbars();
	}
	else if (has_arg(a, "tool")) {
		uint16 id = 0;
		if (!parse_tool_ref(arg_str(a, "tool"), id)) {
			return "unknown tool: use a reference like simple_tool[5] (see toolbars) or a name like TOOL_SWITCH_PLAYER";
		}
		const std::string vis = arg_str(a, "visibility");
		uint8 v;
		if (vis == "show") {
			v = tool_t::VISIBILITY_SHOW;
		}
		else if (vis == "hide") {
			v = tool_t::VISIBILITY_HIDE;
		}
		else if (vis == "default") {
			v = tool_t::VISIBILITY_DEFAULT;
		}
		else {
			return "visibility must be show, hide or default";
		}
		if (v == tool_t::VISIBILITY_SHOW  &&  env_t::networkmode) {
			return "show is not possible in network games";
		}
		const sint16 wt = (sint16)arg_int(a, "waytype", ignore_wt);
		const std::string param = arg_str(a, "param");
		tool_t::set_visibility(id, wt, param.c_str(), v);
		tool_t::update_toolbars();
		j.key("tool").obj();
		write_tool_ids(j, id, wt, param.c_str());
		j.kv("visibility", visibility_name(v));
		j.end_obj();
	}
	write_visibility_rules(j);
	return NULL;
}


/**
 * Lifts the lock of a map locked with "Lock game", so the player can be changed again.
 * Single player only. The setting is saved with the game; the public player keeps its password.
 */
static const char *cmd_unlock_game(const args_t &, json_t &j)
{
	if (env_t::networkmode) {
		return "not available in network games";
	}
	karte_t *welt = world();
	j.kv("was_locked", welt->get_settings().get_allow_player_change() == 0);
	welt->get_settings().set_allow_player_change(true);
	tool_t::update_toolbars();
	j.kv("public_player_password", welt->get_public_player()->is_locked());
	return NULL;
}


/**
 * Removes the password of a player (default: the public player) like the server command
 * "unlock company" does. Single player only. Saved with the game.
 */
static const char *cmd_remove_password(const args_t &a, json_t &j)
{
	if (env_t::networkmode) {
		return "not available in network games";
	}
	karte_t *welt = world();
	const sint64 nr = arg_int(a, "player", PLAYER_PUBLIC_NR);
	player_t *player = (nr >= 0  &&  nr < PLAYER_UNOWNED) ? welt->get_player((uint8)nr) : NULL;
	if (player == NULL) {
		return "no such player";
	}
	j.kv("player", (int)nr);
	j.kv("name", player->get_name());
	j.kv("had_password", !player->access_password_hash().empty());
	pwd_hash_t empty;
	empty.clear();
	player->access_password_hash().clear();
	welt->store_player_password_hash((uint8)nr, empty);
	player->unlock(true, false);
	tool_t::update_toolbars();
	j.kv("locked", player->is_locked());
	return NULL;
}


// ---------------------------------------------------------------------------
// agent mode: allow-listed changes for one company (AI team of the dashboard)
// ---------------------------------------------------------------------------

/*
 * The agent commands (kind CMD_AGENT) let a trusted program, the dashboard bridge, change the game for ONE company
 * (player=N, never the public player) through a few allow-listed operations: build and remove infrastructure
 * (agent_tool), depots (depot_op), lines (line_op), convoys (convoy_op), way planning without building (plan_way)
 * and prices (estimate). They are allowed with -remote_control, and with -remote_control_readonly only together with
 * -remote_control_agent (dedicated server).
 *
 * Who can connect to this port is the authorization, so the tools are sent with WFL_SCRIPT | WFL_NO_CHK like the
 * tools of scenario scripts: a company protected by a password acts in single player and on a network server (the
 * server keeps WFL_NO_CHK of its own commands); on a network client the server removes the flag, so a company that
 * is locked on this client is refused here. WFL_NO_CHK also skips the scenario rules of karte_t::set_tool_api,
 * call_work_api and nwc_tool_t::clone, and the change tools check owners only in network games, so the agent commands
 * check the scenario rules and the owners themselves: every object they use, change or remove must belong to the
 * company. Removals are predicted before the tool is sent; when the prediction is unsure the command is refused.
 *
 * Replies: single player {"result":null,...}; network game {"pending":true}: the tool goes through the server, re-read
 * the game to see its result. The commands open no dialogs (except the short message the engine shows when a convoy is
 * sent to a depot).
 */

/// set by a command that writes "ok" itself (plan_way: "ok":false is a result there, not an error)
static bool reply_wrote_ok = false;


/// error message with several values (make_error takes one)
static const char *agent_error(const char *fmt, ...)
{
	char buf[2048];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	error_buffer = buf;
	return error_buffer.c_str();
}


static std::string pos_text(koord3d pos)
{
	char buf[48];
	snprintf(buf, sizeof(buf), "%d,%d,%d", (int)pos.x, (int)pos.y, (int)pos.z);
	return buf;
}


/// who owns something, for error messages
static std::string owner_text(sint8 nr)
{
	if (nr == PLAYER_PUBLIC_NR) {
		return "the public player";
	}
	if (nr < 0  ||  nr >= PLAYER_UNOWNED) {
		return "nobody (a city or nature)";
	}
	const player_t *player = world()->get_player((uint8)nr);
	char buf[160];
	snprintf(buf, sizeof(buf), "company %d%s%s%s", (int)nr, player ? " (" : "", player ? player->get_name() : "", player ? ")" : "");
	return buf;
}


static void write_pos_array(json_t &j, const char *k, koord3d pos)
{
	j.key(k).arr().num(pos.x).num(pos.y).num(pos.z).end_arr();
}


/// a whole number argument; false if it is missing or not a number
static bool agent_number(const args_t &a, const char *k, sint64 &v)
{
	const std::string s = arg_str(a, k);
	if (s.empty()) {
		return false;
	}
	char *end = NULL;
	v = strtoll(s.c_str(), &end, 10);
	return *end == 0;
}


/// the company of an agent command: player=N, required, never the public player
static const char *get_agent_player(const args_t &a, player_t *&player)
{
	player = NULL;
	sint64 nr = 0;
	if (!has_arg(a, "player")  ||  arg_str(a, "player").empty()) {
		return "player=N is required";
	}
	if (!agent_number(a, "player", nr)) {
		return make_error("player=N must be a number, not '%s'", arg_str(a, "player").c_str());
	}
	if (nr == PLAYER_PUBLIC_NR) {
		return "agents cannot act as the public player";
	}
	player_t *p = (nr >= 0  &&  nr < PLAYER_UNOWNED) ? world()->get_player((uint8)nr) : NULL;
	if (p == NULL) {
		return "no such player";
	}
	if (env_t::networkmode  &&  !env_t::server  &&  p->is_locked()) {
		// the server removes WFL_NO_CHK of tools from clients and drops tools of companies locked for this client
		return make_error("player %s is protected by a password on this client: use the remote control of the server, or unlock the company in this client", p->get_name());
	}
	player = p;
	return NULL;
}


/// the scenario rule for a tool, as set_tool_api, call_work_api and nwc_tool_t::clone check it without WFL_NO_CHK
static const char *agent_scenario_tool(player_t *player, tool_t *tool)
{
	if (!world()->get_scenario()->is_tool_allowed(player, tool->get_id(), tool->get_waytype(), tool->get_default_param())) {
		return "Forbidden by scenario";
	}
	return NULL;
}


/// the scenario rule for a tool at a position (call_work_api, nwc_tool_t::clone)
static const char *agent_scenario_pos(player_t *player, tool_t *tool, koord3d pos)
{
	scenario_t *scen = world()->get_scenario();
	if (!scen->is_scripted()) {
		return NULL;
	}
	if (const char *err = scen->is_work_allowed_here(player, tool->get_id(), tool->get_waytype(), tool->get_default_param(), pos)) {
		return *err ? make_error("%s", err) : make_error("Forbidden by scenario at %s", pos_text(pos).c_str());
	}
	return NULL;
}


/**
 * Route searches call INT_CHECK, which may run a sync step and draw the screen: not while a command computes. In network
 * games the interrupts are always off (stepping with a fixed ratio, or paused), so nothing is changed there.
 */
struct agent_no_interrupts_t
{
	bool restore;
	agent_no_interrupts_t() : restore(!env_t::networkmode  &&  !world()->is_paused())
	{
		if (!env_t::networkmode) {
			intr_disable();
		}
	}
	~agent_no_interrupts_t()
	{
		if (restore) {
			intr_enable();
		}
	}
};


/**
 * Sends a simple tool (TOOL_CHANGE_DEPOT, TOOL_CHANGE_LINE, TOOL_CHANGE_CONVOI, TOOL_RENAME) for an agent as scripts
 * do it (set_tool_api), with WFL_NO_CHK: the scenario rule for the tool, which set_tool_api and nwc_tool_t::clone then
 * skip, is checked here. suspended: network game, the tool goes through the server and works later.
 */
static const char *agent_simple_tool(uint16 nr, const char *param, player_t *player, bool &suspended)
{
	suspended = false;
	karte_t *welt = world();
	if (get_random_mode() & LOAD_RANDOM) {
		return "the game is loading";
	}
	std::unique_ptr<tool_t> tool(create_tool(nr | SIMPLE_TOOL));
	if (!tool) {
		return "could not create this tool";
	}
	tool->set_default_param(param);
	tool->flags = tool_t::WFL_SCRIPT | tool_t::WFL_NO_CHK;
	tool->callback_id = 0;
	if (const char *err = agent_scenario_tool(player, tool.get())) {
		return err;
	}
	// single player: works at once (init); network game: sent to the server as a copy (nwc_tool_t)
	welt->set_tool_api(tool.get(), player, suspended);
	return NULL;
}


static void agent_reply(json_t &j, bool suspended)
{
	if (suspended) {
		j.kv("pending", true);
	}
	else {
		j.key("result").null();
	}
}


// ---- removal prediction ----

/// things that are nobody's property for the removal checks: cursors, pedestrians, city cars, animals, smoke
static bool agent_ignorable(const obj_t *obj)
{
	switch (obj->get_typ()) {
		case obj_t::zeiger:
		case obj_t::pedestrian:
		case obj_t::road_user:
		case obj_t::movingobj:
		case obj_t::cloud:
			return true;
		default:
			return false;
	}
}


static const char *agent_cannot_remove(const obj_t *obj, koord3d pos)
{
	return agent_error("cannot remove %s '%s' at %s: it belongs to %s", obj_type_name(obj->get_typ()), obj->get_name(),
		pos_text(pos).c_str(), owner_text(obj->get_owner_nr()).c_str());
}


/**
 * Every object on the square (also ways; labels only if with_labels) must belong to the company; no vehicles there.
 * keep_nature: trees and ground objects stay (ends of bridges and tunnels, whose objects move to the new ground).
 */
static const char *agent_check_square(const player_t *player, const grund_t *gr, bool with_labels, bool keep_nature = false)
{
	for (uint8 i = 0; i < gr->obj_count(); i++) {
		const obj_t *obj = gr->obj_bei(i);
		if (obj == NULL  ||  agent_ignorable(obj)  ||  (!with_labels  &&  obj->get_typ() == obj_t::label)) {
			continue;
		}
		if (keep_nature  &&  (obj->get_typ() == obj_t::baum  ||  obj->get_typ() == obj_t::groundobj)) {
			continue;
		}
		if (obj->is_moving()) {
			return agent_error("cannot remove at %s now: a vehicle (%s) is there", pos_text(gr->get_pos()).c_str(), obj->get_name());
		}
		if (obj->get_owner_nr() != player->get_player_nr()) {
			return agent_cannot_remove(obj, gr->get_pos());
		}
	}
	return NULL;
}


/// every object on the square whose waytype is wt (tram and track count as the same) must belong to the company
static const char *agent_check_way_objects(const player_t *player, const grund_t *gr, waytype_t wt)
{
	for (uint8 i = 0; i < gr->obj_count(); i++) {
		const obj_t *obj = gr->obj_bei(i);
		if (obj == NULL  ||  agent_ignorable(obj)) {
			continue;
		}
		const waytype_t owt = obj->get_waytype();
		const bool same = owt == wt  ||  (owt == tram_wt  &&  wt == track_wt)  ||  (owt == track_wt  &&  wt == tram_wt);
		if (same  &&  obj->get_owner_nr() != player->get_player_nr()) {
			return agent_cannot_remove(obj, gr->get_pos());
		}
	}
	return NULL;
}


/**
 * What bridge_builder_t::remove(player, start, wegtyp) removes: the whole bridge found from start (the same walk),
 * every object on its squares, the pillars below, and ways next to it that it shortens or removes (bridges that do not
 * end on the ground). All of it must belong to the company. covered collects the bridge squares.
 */
static const char *agent_predict_bridge(const player_t *player, koord3d pos_start, waytype_t wegtyp, vector_tpl<koord3d> *covered)
{
	karte_t *welt = world();
	if (wegtyp == powerline_wt) {
		return agent_error("cannot remove the powerline bridge at %s as an agent", pos_text(pos_start).c_str());
	}
	vector_tpl<koord3d> part_list, end_list, tmp_list;
	vector_tpl<const grund_t *> marked;
	const grund_t *gs = welt->lookup(pos_start);
	if (gs == NULL) {
		return "no ground there";
	}
	tmp_list.append(pos_start);
	marked.append(gs);
	do {
		const koord3d pos = tmp_list.pop_back();
		const grund_t *from = welt->lookup(pos);
		if (from == NULL) {
			return agent_error("cannot remove the bridge at %s as an agent: unusual bridge", pos_text(pos_start).c_str());
		}
		grund_t *to;
		koord zv = koord::invalid;
		if (pos != pos_start  &&  from->ist_karten_boden()) {
			if (from->get_grund_hang() != slope_t::flat) {
				zv = -koord(from->get_grund_hang());
			}
			else if (from->get_weg_hang() != slope_t::flat) {
				zv = koord(from->get_weg_hang());
			}
			end_list.append(pos);
		}
		else if (pos == pos_start) {
			if (from->ist_karten_boden()) {
				if (from->get_grund_hang() != slope_t::flat) {
					zv = -koord(from->get_grund_hang());
				}
				else if (from->get_weg_hang() != slope_t::flat) {
					zv = koord(from->get_weg_hang());
				}
				end_list.append(pos);
			}
			else {
				const weg_t *w0 = from->get_weg_nr(0);
				if (w0 == NULL) {
					return agent_error("cannot remove the bridge at %s as an agent: unusual bridge", pos_text(pos_start).c_str());
				}
				const ribi_t::ribi r = w0->get_ribi_unmasked();
				const ribi_t::ribi dir1 = r & ribi_t::northeast;
				const ribi_t::ribi dir2 = r & ribi_t::southwest;
				bool is_end1 = dir1 == ribi_t::none;
				if (ribi_t::is_single(dir1)) {
					is_end1 = !from->get_neighbour(to, wegtyp, dir1)  ||  !to->ist_bruecke();
				}
				bool is_end2 = dir2 == ribi_t::none;
				if (ribi_t::is_single(dir2)) {
					is_end2 = !from->get_neighbour(to, wegtyp, dir2)  ||  !to->ist_bruecke();
				}
				if (!is_end1  &&  !is_end2) {
					return "Cannot delete a bridge from its centre";
				}
				zv = koord(is_end1 ? dir2 : dir1);
				part_list.append(pos);
			}
		}
		else if (from->ist_bruecke()) {
			part_list.append(pos);
		}
		if (const char *msg = from->kann_alle_obj_entfernen(player)) {
			if (const char *err = agent_check_square(player, from, true, from->ist_karten_boden())) {
				return err; // names what belongs to whom
			}
			return agent_error("cannot remove the bridge at %s: %s (at %s)", pos_text(pos_start).c_str(), msg, pos_text(pos).c_str());
		}
		if (from->get_halt().is_bound()  &&  from->get_halt()->get_first_owner() != player) {
			return agent_error("cannot remove the bridge at %s: the stop at %s belongs to %s", pos_text(pos_start).c_str(),
				pos_text(pos).c_str(), from->get_halt()->get_first_owner() ? owner_text(from->get_halt()->get_first_owner()->get_player_nr()).c_str() : "nobody");
		}
		for (int r = 0; r < 4; r++) {
			if ((zv == koord::invalid  ||  zv == koord::nesw[r])  &&  from->get_neighbour(to, wegtyp, ribi_t::nesw[r])  &&  !marked.is_contained(to)  &&  to->ist_bruecke()) {
				tmp_list.append(to->get_pos());
				marked.append(to);
			}
		}
	} while (!tmp_list.empty());

	// everything on the bridge squares is removed (ways and stops too)
	vector_tpl<koord3d> all = part_list;
	for (koord3d const &pos : end_list) {
		all.append(pos);
	}
	for (koord3d const &pos : all) {
		if (const char *err = agent_check_square(player, welt->lookup(pos), true, end_list.is_contained(pos))) {
			return err;
		}
		if (covered) {
			covered->append_unique(pos);
		}
	}
	for (koord3d const &pos : part_list) {
		// all pillars on the ground below are removed, also those of other bridges or elevated ways there
		const grund_t *ground = welt->lookup_kartenboden(pos.get_2d());
		for (uint8 i = 0; ground  &&  i < ground->obj_count(); i++) {
			const obj_t *obj = ground->obj_bei(i);
			if (obj->get_typ() == obj_t::pillar  &&  obj->get_owner_nr() != player->get_player_nr()) {
				return agent_cannot_remove(obj, ground->get_pos());
			}
		}
		// bridges without a ramp: the ways they continue from are shortened or removed
		const grund_t *gr = welt->lookup(pos);
		const ribi_t::ribi bridge_ribi = gr->get_weg_ribi_unmasked(wegtyp);
		for (uint i = 0; i < 4; i++) {
			grund_t *prev;
			if ((bridge_ribi & ribi_t::nesw[i])  &&  gr->get_neighbour(prev, wegtyp, ribi_t::nesw[i])  &&  !prev->ist_bruecke()  &&  !end_list.is_contained(prev->get_pos())) {
				if (const char *err = agent_check_square(player, prev, true)) {
					return err;
				}
			}
		}
	}
	for (koord3d const &pos : end_list) {
		// ramps: a higher way next to them (elevated way) is shortened or removed
		const grund_t *gr = welt->lookup(pos);
		const ribi_t::ribi bridge_ribi = gr->get_weg_ribi_unmasked(wegtyp);
		for (uint i = 0; i < 4; i++) {
			grund_t *prev;
			if ((bridge_ribi & ribi_t::nesw[i])  &&  gr->get_neighbour(prev, wegtyp, ribi_t::nesw[i])  &&  !part_list.is_contained(prev->get_pos())  &&  prev->get_hoehe() > gr->get_hoehe()) {
				if (const char *err = agent_check_square(player, prev, true)) {
					return err;
				}
			}
		}
	}
	return NULL;
}


/**
 * What tunnel_builder_t::remove(player, start, wegtyp, remove_all) removes: all tunnel squares found from start (the
 * same walk, branches only with remove_all = ctrl) with everything on them, and the portals. All of it must belong to
 * the company.
 */
static const char *agent_predict_tunnel(const player_t *player, koord3d start, waytype_t wegtyp, bool remove_all)
{
	karte_t *welt = world();
	vector_tpl<koord3d> squares, tmp_list;
	vector_tpl<const grund_t *> marked;
	const grund_t *gs = welt->lookup(start);
	if (gs == NULL) {
		return "no ground there";
	}
	tmp_list.append(start);
	marked.append(gs);
	do {
		const koord3d pos = tmp_list.pop_back();
		const grund_t *from = welt->lookup(pos);
		grund_t *to;
		koord zv = koord::invalid;
		if (from->ist_karten_boden()) {
			// a portal: search only into the tunnel
			zv = koord(from->get_grund_hang());
		}
		squares.append(pos);
		if (const char *msg = from->kann_alle_obj_entfernen(player)) {
			if (const char *err = agent_check_square(player, from, true, from->ist_karten_boden())) {
				return err; // names what belongs to whom
			}
			return agent_error("cannot remove the tunnel at %s: %s (at %s)", pos_text(start).c_str(), msg, pos_text(pos).c_str());
		}
		const ribi_t::ribi waytype_ribi = from->get_weg_ribi_unmasked(wegtyp);
		if (!remove_all  &&  ribi_t::is_threeway(waytype_ribi)) {
			return "This tunnel branches. You can try Control+Click to remove.";
		}
		for (int r = 0; r < 4; r++) {
			if ((zv == koord::invalid  ||  zv == koord::nesw[r])  &&  from->get_neighbour(to, wegtyp, ribi_t::nesw[r])  &&  !marked.is_contained(to)) {
				tmp_list.append(to->get_pos());
				marked.append(to);
			}
		}
	} while (!tmp_list.empty());

	for (koord3d const &pos : squares) {
		const grund_t *gr = welt->lookup(pos);
		if (const char *err = agent_check_square(player, gr, true, gr->ist_karten_boden())) {
			return err;
		}
	}
	return NULL;
}


/**
 * Predicts what tool_remover_t removes at pos (tool_remover_t::tool_remover_intern, the same order of checks) and
 * refuses unless all of it belongs to the company. type: obj_t::undefined, signal, roadsign, wayobj or bahndepot.
 * NULL: the remover only removes things of the company there.
 */
static const char *agent_predict_remover(const player_t *player, koord3d pos, int type, bool ctrl)
{
	karte_t *welt = world();
	const grund_t *gr = welt->lookup(pos);
	const std::string where = pos_text(pos);
	const sint8 me = player->get_player_nr();
	if (gr == NULL  ||  gr->obj_count() == 0) {
		return agent_error("nothing to remove at %s", where.c_str());
	}
	const bool any = type == obj_t::undefined;

	if (any) {
		// markers first
		if (label_t *label = gr->find<label_t>()) {
			if (label->get_removal_error(player) == NULL) {
				return label->get_owner_nr() == me ? NULL : agent_cannot_remove(label, pos);
			}
			if (gr->obj_count() == 1) {
				return agent_cannot_remove(label, pos);
			}
		}
		// the remover deletes a city car on the square instead of anything else
		if (gr->find<private_car_t>()) {
			return agent_error("cannot remove at %s now: a city car is on this square and would be removed instead; try again", where.c_str());
		}
	}

	// powerlines (can cross ground of another company)
	leitung_t *lt = gr->get_leitung();
	if (any  &&  lt  &&  lt->get_removal_error(player) == NULL) {
		if (lt->get_owner_nr() != me) {
			return agent_cannot_remove(lt, pos);
		}
		if ((gr->get_typ() == grund_t::monorailboden  &&  !gr->get_weg_nr(0))  ||  gr->ist_bruecke()  ||  gr->ist_tunnel()) {
			return agent_error("cannot remove the powerline at %s as an agent: elevated, bridge and tunnel powerlines are not supported", where.c_str());
		}
		return NULL;
	}

	// signal or roadsign
	obj_t *rs = gr->suche_obj(obj_t::signal);
	if (rs == NULL) {
		rs = gr->suche_obj(obj_t::roadsign);
	}
	if ((any  ||  type == obj_t::signal  ||  type == obj_t::roadsign)  &&  rs) {
		return rs->get_owner_nr() == me ? NULL : agent_cannot_remove(rs, pos);
	}

	// stop (not at a factory, e.g. an oil rig): the building of this square
	if (any  &&  gr->is_halt()  &&  gr->get_halt().is_bound()  &&  fabrik_t::get_fab(pos.get_2d()) == NULL) {
		gebaeude_t *gb = gr->find<gebaeude_t>();
		if (gb  &&  gb->check_owner(player)) {
			return gb->get_owner_nr() == me ? NULL : agent_cannot_remove(gb, pos);
		}
	}

	// catenary or other way object
	if (wayobj_t *wo = gr->find<wayobj_t>()) {
		if (any  ||  type == obj_t::wayobj) {
			return wo->get_owner_nr() == me ? NULL : agent_cannot_remove(wo, pos);
		}
	}

	// bridge: the whole bridge
	if (any  &&  gr->ist_bruecke()) {
		bruecke_t *br = gr->find<bruecke_t>();
		if (br == NULL) {
			return agent_error("cannot remove at %s as an agent: unusual bridge square", where.c_str());
		}
		return agent_predict_bridge(player, pos, br->get_desc()->get_waytype(), NULL);
	}

	// tunnel portal: the whole tunnel
	if (any  &&  gr->ist_tunnel()  &&  gr->ist_karten_boden()) {
		const weg_t *w = gr->get_weg_nr(0);
		if (gr->get_leitung()  ||  w == NULL) {
			return agent_error("cannot remove the tunnel at %s as an agent: powerline tunnels are not supported", where.c_str());
		}
		return agent_predict_tunnel(player, pos, w->get_waytype(), ctrl);
	}

	// fields belong to factories
	if (any  &&  gr->find<field_t>()) {
		return agent_error("cannot remove the field at %s: it belongs to a factory", where.c_str());
	}

	// depot
	depot_t *dep = gr->get_depot();
	if (dep  &&  (any  ||  type == obj_t::bahndepot)) {
		if (dep->get_owner_nr() != me) {
			return agent_cannot_remove(dep, pos);
		}
		if (const char *msg = dep->get_removal_error(player)) {
			return agent_error("cannot remove the depot at %s: %s", where.c_str(), msg);
		}
		return NULL;
	}

	// other buildings (all squares of the building)
	gebaeude_t *gb = gr->find<gebaeude_t>();
	if (any  &&  gb) {
		gb = gb->get_first_tile();
		if (gb->get_owner_nr() != me) {
			return agent_cannot_remove(gb, pos);
		}
		if (gb->is_townhall()) {
			return agent_error("cannot remove the town hall at %s", where.c_str());
		}
		return NULL;
	}

	if (!any) {
		for (uint8 i = 0; i < gr->obj_count(); i++) {
			if (gr->obj_bei(i)->get_typ() == type) {
				return agent_error("cannot remove this object at %s as an agent", where.c_str());
			}
		}
		return agent_error("nothing of this type to remove at %s", where.c_str());
	}

	// the rest: the remover takes out crossings, markers, cursors, aircraft and a powerline of another company, then
	// removes all other objects except ways at once if it may remove all of them; only if there are none, one way
	bool crossing = false;
	vector_tpl<obj_t *> others;
	for (uint8 i = 0; i < gr->obj_count(); i++) {
		obj_t *obj = gr->obj_bei(i);
		const obj_t::typ t = obj->get_typ();
		if (t == obj_t::way  ||  obj == lt  ||  t == obj_t::zeiger  ||  t == obj_t::label) {
			continue;
		}
		if (t == obj_t::crossing) {
			crossing = true;
			continue;
		}
		if (t == obj_t::air_vehicle  ||  (obj->is_moving()  &&  !agent_ignorable(obj))) {
			return agent_error("cannot remove at %s now: a vehicle (%s) is there", where.c_str(), obj->get_name());
		}
		others.append(obj);
	}
	if (crossing) {
		return agent_error("cannot remove the crossing at %s with the remover as an agent: use tool_remove_way for one of its ways", where.c_str());
	}
	for (obj_t *obj : others) {
		if (const char *msg = obj->get_removal_error(player)) {
			return agent_error("cannot remove %s '%s' at %s: %s", obj_type_name(obj->get_typ()), obj->get_name(), where.c_str(), msg);
		}
	}
	const bool tunnel_ground = gr->get_typ() == grund_t::tunnelboden;
	if (!others.empty()  &&  !tunnel_ground) {
		for (obj_t *obj : others) {
			if (!agent_ignorable(obj)  &&  obj->get_owner_nr() != me) {
				return agent_cannot_remove(obj, pos);
			}
		}
		return NULL;
	}
	if (!tunnel_ground  ||  gr->has_two_ways()) {
		// one way, the second one first (not water)
		weg_t *w = gr->get_weg_nr(1);
		if (w  &&  w->get_waytype() == water_wt) {
			w = NULL;
		}
		if (w == NULL  ||  w->get_removal_error(player) != NULL) {
			w = gr->get_weg_nr(0);
			if (w == NULL) {
				return agent_error("nothing to remove at %s", where.c_str());
			}
		}
		return w->get_owner_nr() == me ? NULL : agent_cannot_remove(w, pos);
	}
	// a square in a tunnel with one way: the way, everything on it and the square
	return agent_check_square(player, gr, true);
}


/// way_checker_t (and scenario_checker_t) of simtool.cc: the route of tool_wayremover_t and tool_build_wayobj_t
class agent_way_checker_t : public test_driver_t
{
	waytype_t wt;
	const player_t *player;
	uint16 tool_id;
	bool scenario;
public:
	agent_way_checker_t(waytype_t w, const player_t *p, uint16 id) : wt(w), player(p), tool_id(id), scenario(world()->get_scenario()->is_scripted()) {}
	bool check_next_tile(const grund_t *gr) const OVERRIDE
	{
		return gr->hat_weg(wt)  &&  (!scenario  ||  world()->get_scenario()->is_work_allowed_here(player, tool_id, wt, 0, gr->get_pos()) == NULL);
	}
	ribi_t::ribi get_ribi(const grund_t *gr) const OVERRIDE { return gr->get_weg_ribi(wt); }
	waytype_t get_waytype() const OVERRIDE { return wt; }
	int get_cost(const grund_t *, const weg_t *, const sint32, ribi_t::ribi) const OVERRIDE { return 1; }
	bool is_target(const grund_t *, const grund_t *) const OVERRIDE { return false; }
};


/**
 * Predicts what tool_wayremover_t removes from start to end (the same route and checks as its calc_route/do_work):
 * the ways of the waytype along the route (or some of their directions), the signs, way objects, tunnels and stops of
 * that waytype on them, whole bridges that start on the route, and on squares in tunnels or of elevated ways whose way
 * goes completely everything there. All of it must belong to the company.
 */
static const char *agent_predict_wayremover(const player_t *player, koord3d start, koord3d end, waytype_t tool_wt)
{
	karte_t *welt = world();
	const waytype_t wt = tool_wt;
	route_t verbindung;
	if (start == end) {
		const grund_t *gr = welt->lookup(start);
		if (gr  &&  gr->get_weg(wt)) {
			verbindung.append(start);
		}
	}
	else {
		agent_way_checker_t driver(wt, player, TOOL_WAYREMOVER | GENERAL_TOOL);
		agent_no_interrupts_t no_interrupts;
		verbindung.calc_route(welt, start, end, &driver, 0, 0);
	}
	if (verbindung.get_count() == 0  ||  (start != end  &&  verbindung.get_count() < 2)) {
		return "Ways not connected";
	}
	koord3d_vector_t const &route = verbindung.get_route();
	// the checks of tool_wayremover_t::calc_route: if one fails, the tool removes nothing
	for (koord3d const &pos : route) {
		const grund_t *gr = welt->lookup(pos);
		if (gr == NULL  ||  gr->get_weg(wt) == NULL) {
			return "Ways not connected";
		}
		if (gr->get_depot()) {
			return agent_error("cannot remove the way at %s as an agent: there is a depot (remove the depot first)", pos_text(pos).c_str());
		}
		const bool check_all = !gr->ist_karten_boden()  &&  gr->has_two_ways()  &&  gr->get_weg_nr(0)->get_waytype() == wt;
		for (uint8 i = 0; i < gr->obj_count(); i++) {
			obj_t *obj = gr->obj_bei(i);
			const obj_t::typ t = obj->get_typ();
			if (t == obj_t::pillar  ||  t == obj_t::leitung) {
				continue;
			}
			if (t == obj_t::air_vehicle  &&  !static_cast<air_vehicle_t *>(obj)->is_on_ground()) {
				continue;
			}
			const waytype_t obj_wt = obj->get_waytype();
			bool check = true;
			if (obj_wt != invalid_wt) {
				const bool force_remove = (t == obj_t::gebaeude  &&  !gr->has_two_ways())  ||  (obj_wt == tram_wt  &&  wt == track_wt);
				check = check_all  ||  obj_wt == wt  ||  force_remove;
			}
			if (check) {
				if (const char *msg = obj->get_removal_error(player)) {
					if (obj->get_owner_nr() != player->get_player_nr()) {
						return agent_cannot_remove(obj, pos);
					}
					return agent_error("cannot remove the way at %s: %s", pos_text(pos).c_str(), msg);
				}
			}
		}
	}
	// what tool_wayremover_t::do_work removes
	vector_tpl<koord3d> covered;
	for (uint32 i = 0; i < route.get_count(); i++) {
		const koord3d pos = route[i];
		const grund_t *gr = welt->lookup(pos);
		if (gr == NULL  ||  gr->is_water()  ||  covered.is_contained(pos)) {
			continue;
		}
		if (gr->ist_bruecke()) {
			const bruecke_t *br = gr->find<bruecke_t>();
			if (br == NULL) {
				return agent_error("cannot remove the way at %s as an agent: unusual bridge square", pos_text(pos).c_str());
			}
			if (br->get_desc()->get_waytype() == wt) {
				if (bridge_builder_t::is_start_of_bridge(gr)) {
					if (const char *err = agent_predict_bridge(player, pos, wt, &covered)) {
						return err;
					}
				}
				// the way on a bridge stays (or went with the bridge)
				continue;
			}
		}
		ribi_t::ribi rem = 15 ^ route.get_ribi(i);
		if (route.get_count() <= 1) {
			rem = 0;
		}
		const weg_t *w = gr->get_weg(wt);
		if (w->get_owner_nr() != player->get_player_nr()) {
			return agent_cannot_remove(w, pos);
		}
		if (wt == water_wt  &&  pos.z == welt->get_water_hgt(pos.get_2d())  &&  gr->get_grund_hang() != slope_t::flat) {
			rem &= ~ribi_t::doubles(ribi_type(gr->get_grund_hang()));
		}
		const bool completely = (w->get_ribi_unmasked() & rem) == 0;
		if (gr->is_halt()  &&  !gr->has_two_ways()) {
			// the stop on this square goes
			if (const gebaeude_t *gb = gr->find<gebaeude_t>()) {
				if (gb->get_owner_nr() != player->get_player_nr()) {
					return agent_cannot_remove(gb, pos);
				}
			}
		}
		if (const char *err = agent_check_way_objects(player, gr, wt)) {
			return err;
		}
		if (completely  &&  !gr->ist_karten_boden()  &&  (gr->get_typ() == grund_t::tunnelboden  ||  gr->get_typ() == grund_t::monorailboden)  &&  gr->get_weg_nr(0)->get_waytype() == wt) {
			// in a tunnel or elevated: the square goes with everything on it, also a second way
			if (const char *err = agent_check_square(player, gr, true)) {
				return err;
			}
		}
	}
	return NULL;
}


/**
 * Predicts what tool_remove_wayobj_t (tool_build_wayobj_t with build=false) changes from start to end: on every square
 * of its route the way objects of the waytype are removed or lose directions. All of them must belong to the company.
 */
static const char *agent_predict_remove_wayobj(const player_t *player, koord3d start, koord3d end, waytype_t wt)
{
	karte_t *welt = world();
	const grund_t *gs = welt->lookup(start);
	const grund_t *ge = welt->lookup(end);
	if (gs == NULL  ||  ge == NULL) {
		return "Ways not connected";
	}
	waytype_t waytype = wt;
	if (waytype == track_wt) {
		if (const depot_t *dp = gs->get_depot()) {
			waytype = dp->get_waytype();
		}
		else if (const depot_t *dp = ge->get_depot()) {
			waytype = dp->get_waytype();
		}
	}
	route_t verbindung;
	if (start != end) {
		agent_way_checker_t driver(waytype == tram_wt ? track_wt : waytype, player, TOOL_REMOVE_WAYOBJ | GENERAL_TOOL);
		agent_no_interrupts_t no_interrupts;
		if (verbindung.calc_route(welt, start, end, &driver, 0, 0) == route_t::no_route) {
			return "Ways not connected";
		}
	}
	else {
		verbindung.append(start);
	}
	for (koord3d const &pos : verbindung.get_route()) {
		const grund_t *gr = welt->lookup(pos);
		for (uint8 i = 0; gr  &&  i < gr->obj_count(); i++) {
			const obj_t *obj = gr->obj_bei(i);
			if (obj->get_typ() == obj_t::wayobj  &&  obj->get_waytype() == wt  &&  obj->get_owner_nr() != player->get_player_nr()) {
				return agent_cannot_remove(obj, pos);
			}
		}
	}
	return NULL;
}


// ---- agent commands ----

/// the general tools an agent may use (infrastructure of its own company)
static const uint16 agent_tools[] = {
	TOOL_BUILD_WAY, TOOL_BUILD_BRIDGE, TOOL_BUILD_TUNNEL, TOOL_WAYREMOVER, TOOL_BUILD_WAYOBJ, TOOL_REMOVE_WAYOBJ,
	TOOL_BUILD_STATION, TOOL_BUILD_ROADSIGN, TOOL_BUILD_DEPOT, TOOL_REMOVER
};


/// object type parameters of the remover that agents may use (none = anything, in the remover's order)
static bool agent_remover_type(const std::string &param, int &type)
{
	type = obj_t::undefined;
	if (param.empty()) {
		return true;
	}
	char *end = NULL;
	const long t = strtol(param.c_str(), &end, 10);
	if (*end != 0) {
		return false;
	}
	if (t == 0  ||  t == -1) {
		return true;
	}
	if (t == obj_t::signal  ||  t == obj_t::roadsign  ||  t == obj_t::wayobj  ||  t == obj_t::bahndepot) {
		type = (int)t;
		return true;
	}
	return false;
}


/// a waytype number as the removal tools take it
static bool agent_waytype_param(const std::string &param, waytype_t &wt)
{
	char *end = NULL;
	const long v = strtol(param.c_str(), &end, 10);
	if (param.empty()  ||  *end != 0) {
		return false;
	}
	wt = (waytype_t)v;
	return true;
}


static const char *agent_check_available(const obj_desc_timelined_t *desc, const char *what, const char *name)
{
	if (desc == NULL) {
		return agent_error("no %s named '%s'", what, name);
	}
	const uint16 month = world()->get_timeline_year_month();
	if (!desc->is_available(month)) {
		return agent_error("%s '%s' is %s", what, name, desc->is_future(month) ? "not available yet" : "obsolete");
	}
	return NULL;
}


/**
 * The parameter of an agent tool: build tools need the name of an object that is available now (no future or obsolete
 * objects, no defaults by waytype); the removal tools only the waytypes and object types that are predicted.
 */
static const char *agent_check_tool_param(uint16 nr, bool has_param, const std::string &param)
{
	switch (nr) {
		case TOOL_BUILD_WAY: {
			// <way>[,[a][k][s][t][,<max length>,<bridge>[,<tunnel>]]] (tool_build_way_t::init)
			const size_t comma = param.find(',');
			const std::string name = param.substr(0, comma);
			const way_desc_t *desc = way_builder_t::get_desc(name.c_str(), 0);
			if (const char *err = agent_check_available(desc, "way", name.c_str())) {
				return err;
			}
			if (desc->get_styp() == type_river) {
				return "agents cannot build rivers";
			}
			if (comma != std::string::npos) {
				size_t i = comma + 1;
				for (const char *flag = "akst"; *flag; flag++) {
					if (i < param.size()  &&  param[i] == *flag) {
						i++;
					}
				}
				if (i < param.size()  &&  param[i] == ',') {
					const size_t next = param.find(',', i + 1);
					if (next != std::string::npos) {
						const std::string rest = param.substr(next + 1);
						const size_t c2 = rest.find(',');
						const std::string bridge = rest.substr(0, c2);
						const std::string tunnel = c2 == std::string::npos ? std::string() : rest.substr(c2 + 1);
						if (!bridge.empty()) {
							if (const char *err = agent_check_available(bridge_builder_t::get_desc(bridge.c_str()), "bridge", bridge.c_str())) {
								return err;
							}
						}
						if (!tunnel.empty()) {
							if (const char *err = agent_check_available(tunnel_builder_t::get_desc(tunnel.c_str()), "tunnel", tunnel.c_str())) {
								return err;
							}
						}
					}
				}
				else if (i < param.size()) {
					return "param of tool_build_way: <way>[,[a][k][s][t][,<max length>,<bridge>[,<tunnel>]]]";
				}
			}
			return NULL;
		}
		case TOOL_BUILD_BRIDGE:
			return agent_check_available(bridge_builder_t::get_desc(param.c_str()), "bridge", param.c_str());
		case TOOL_BUILD_TUNNEL:
			return agent_check_available(tunnel_builder_t::get_desc(param.c_str()), "tunnel", param.c_str());
		case TOOL_BUILD_WAYOBJ:
			return agent_check_available(wayobj_t::find_desc(param.c_str()), "way object", param.c_str());
		case TOOL_BUILD_ROADSIGN:
			return agent_check_available(roadsign_t::find_desc(param.c_str()), "sign", param.c_str());
		case TOOL_BUILD_STATION: {
			// <name>[,<rotation>] (tool_build_station_t::get_desc)
			std::string name = param;
			const size_t comma = param.rfind(',');
			if (comma != std::string::npos) {
				name = param.substr(0, comma);
			}
			const building_tile_desc_t *tile = hausbauer_t::find_tile(name.c_str(), 0);
			const building_desc_t *desc = tile ? tile->get_desc() : NULL;
			if (desc  &&  (!desc->is_transport_building()  ||  desc->is_depot())) {
				return make_error("'%s' is not a stop or station building", name.c_str());
			}
			return agent_check_available(desc, "station", name.c_str());
		}
		case TOOL_BUILD_DEPOT: {
			const building_tile_desc_t *tile = hausbauer_t::find_tile(param.c_str(), 0);
			const building_desc_t *desc = tile ? tile->get_desc() : NULL;
			if (desc  &&  !desc->is_depot()) {
				return make_error("'%s' is not a depot", param.c_str());
			}
			return agent_check_available(desc, "depot", param.c_str());
		}
		case TOOL_REMOVER: {
			int type;
			if (!agent_remover_type(has_param ? param : std::string(), type)) {
				return "param of tool_remover for agents: nothing (remove what the remover removes first), 8 (signal), 19 (roadsign), 25 (way object) or 12 (depot)";
			}
			return NULL;
		}
		case TOOL_WAYREMOVER: {
			waytype_t wt;
			if (!agent_waytype_param(param, wt)) {
				return "param of tool_remove_way: the waytype number (1 road, 2 track and tram, 3 water, 5 monorail, 6 maglev, 8 narrow gauge, 16 air)";
			}
			if (wt == tram_wt) {
				return "tool_remove_way: use waytype 2 (track) for tram tracks";
			}
			if (wt != road_wt  &&  wt != track_wt  &&  wt != water_wt  &&  wt != monorail_wt  &&  wt != maglev_wt  &&  wt != narrowgauge_wt  &&  wt != air_wt) {
				return "tool_remove_way: agents can remove ways of the waytypes 1, 2, 3, 5, 6, 8 and 16 (no powerlines)";
			}
			return NULL;
		}
		case TOOL_REMOVE_WAYOBJ: {
			waytype_t wt;
			if (!agent_waytype_param(param, wt)  ||  wt == ignore_wt  ||  wt == overheadlines_wt  ||  wt == powerline_wt  ||  wt == decoration_wt  ||  wt < 0) {
				return "param of tool_remove_wayobj: the waytype number of the way objects (1 road, 2 track, 3 water, 5 monorail, 6 maglev, 7 tram, 8 narrow gauge, 16 air)";
			}
			return NULL;
		}
		default:
			return NULL;
	}
}


/**
 * agent: agent_tool tool=<name|id> x,y[,z] [x2,y2[,z2]] [param=...] [ctrl=1] [shift=1] player=N
 * Like the command tool, for the infrastructure tools of agent_tools only: build way, bridge, tunnel, way object,
 * station, roadsign, depot; remove way, way object; the remover. Objects to build must be available now. Before a
 * removal the command predicts everything the tool would remove (whole bridges and tunnels too) and refuses ("cannot
 * remove ...") unless all of it belongs to the company.
 */
static const char *cmd_agent_tool(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	player_t *player;
	if (const char *err = get_agent_player(a, player)) {
		return err;
	}
	uint16 id = 0;
	const std::string tool_name = arg_str(a, "tool");
	if (const char *err = parse_work_tool(tool_name, id)) {
		return err;
	}
	const uint16 nr = id & 0x0FFF;
	bool allowed = false;
	for (uint16 t : agent_tools) {
		allowed |= t == nr;
	}
	if (!allowed) {
		return make_error("tool '%s' is not allowed for agents (only: build way, bridge, tunnel, wayobj, station, roadsign, depot; remove way, wayobj; remover)", tool_name.c_str());
	}
	koord3d start, end = koord3d::invalid;
	if (const char *err = get_tile_pos(a, start)) {
		return err;
	}
	const bool twoclick = has_arg(a, "x2")  ||  has_arg(a, "y2");
	if (twoclick) {
		if (const char *err = get_tile_pos(a, end, "x2", "y2", "z2")) {
			return err;
		}
	}
	const bool has_param = has_arg(a, "param");
	const std::string param = arg_str(a, "param");
	if (const char *err = agent_check_tool_param(nr, has_param, param)) {
		return err;
	}

	std::unique_ptr<tool_t> tool(create_tool(id));
	if (!tool) {
		return "could not create this tool";
	}
	// the tool keeps a pointer to its parameter, which must live until the tool is deleted
	tool->set_default_param(has_param ? param.c_str() : NULL);
	tool->flags = tool_t::WFL_SCRIPT | tool_t::WFL_NO_CHK;
	if (arg_bool(a, "ctrl", false)) {
		tool->flags |= tool_t::WFL_CTRL;
	}
	if (arg_bool(a, "shift", false)) {
		tool->flags |= tool_t::WFL_SHIFT;
	}
	tool->callback_id = 0;

	// the same checks as cmd_tool
	const uint8 flags = tool->flags; // init() may reset them
	if (!tool->is_init_keeps_game_state()) {
		return "Initializing tool has side effects";
	}
	if (!tool->init(player)) {
		return "Error during initializing tool";
	}
	tool->flags = flags;
	if (tool->is_work_keeps_game_state()  ||  (!twoclick  &&  tool->is_work_here_keeps_game_state(player, start))) {
		return "Tool has no effects (it cannot work at this position, or it needs a second position x2,y2)";
	}
	if (twoclick) {
		if (dynamic_cast<two_click_tool_t *>(tool.get()) == NULL) {
			return "Cannot call this tool with two coordinates";
		}
		if (!tool->is_work_here_keeps_game_state(player, start)) {
			return "First click has side effects";
		}
	}

	// the scenario rules, which WFL_NO_CHK skips in call_work_api and nwc_tool_t::clone
	if (const char *err = agent_scenario_tool(player, tool.get())) {
		return err;
	}
	if (const char *err = agent_scenario_pos(player, tool.get(), start)) {
		return err;
	}
	if (twoclick) {
		if (const char *err = agent_scenario_pos(player, tool.get(), end)) {
			return err;
		}
	}

	// removals: only what belongs to the company
	if (nr == TOOL_REMOVER) {
		int type = obj_t::undefined;
		agent_remover_type(has_param ? param : std::string(), type);
		if (const char *err = agent_predict_remover(player, start, type, (flags & tool_t::WFL_CTRL) != 0)) {
			return err;
		}
	}
	else if (nr == TOOL_WAYREMOVER  ||  nr == TOOL_REMOVE_WAYOBJ) {
		waytype_t wt = invalid_wt;
		agent_waytype_param(param, wt);
		const char *err = nr == TOOL_WAYREMOVER ? agent_predict_wayremover(player, start, end, wt) : agent_predict_remove_wayobj(player, start, end, wt);
		if (err) {
			return err;
		}
	}

	bool suspended = false;
	const char *err = NULL;
	if (twoclick) {
		// first click: only sets the start (checked above), never sent to the server
		err = welt->call_work_api(tool.get(), player, start, suspended);
	}
	if (err == NULL) {
		// network game: sent to the server as a copy (nwc_tool_t), so the tool can be deleted afterwards
		err = welt->call_work_api(tool.get(), player, twoclick ? end : start, suspended);
	}
	if (err) {
		// copied, the text may belong to the tool, which is deleted on return
		return *err ? make_error("%s", err) : "the tool did not work here (no reason given)";
	}
	agent_reply(j, suspended);
	return NULL;
}


/// the depot at x,y[,z]; without z the depot on any ground of the square
static const char *find_depot(const args_t &a, depot_t *&depot)
{
	karte_t *welt = world();
	depot = NULL;
	if (!has_arg(a, "x")  ||  !has_arg(a, "y")) {
		return "missing tile coordinates x,y";
	}
	const koord k((sint16)arg_int(a, "x", 0), (sint16)arg_int(a, "y", 0));
	const planquadrat_t *plan = welt->access(k);
	if (plan == NULL) {
		return "tile coordinates outside of the map";
	}
	for (unsigned i = 0; i < plan->get_boden_count()  &&  depot == NULL; i++) {
		const grund_t *gr = plan->get_boden_bei(i);
		if (!has_arg(a, "z")  ||  gr->get_pos().z == (sint8)arg_int(a, "z", 0)) {
			depot = gr->get_depot();
		}
	}
	if (depot == NULL) {
		return make_error("no depot at %s", k.get_str());
	}
	return NULL;
}


/**
 * A depot: x,y[,z] -> {"pos":[x,y,z],"owner":n,"waytype":"road","name":"...","max_convoy_length":n,
 * "convoys":[{"id":n,"name":"...","vehicles":["<desc>",...],"line":<id>|null}],"stored":["<desc>",...]}
 */
static const char *cmd_depot(const args_t &a, json_t &j)
{
	depot_t *depot;
	if (const char *err = find_depot(a, depot)) {
		return err;
	}
	write_pos_array(j, "pos", depot->get_pos());
	j.kv("owner", owner_of(depot->get_owner_nr()));
	j.kv("waytype", waytype_name(depot->get_waytype()));
	j.kv("name", depot->get_tile()->get_desc()->get_name());
	j.kv("max_convoy_length", (int)depot->get_max_convoi_length());
	j.key("convoys").arr();
	for (convoihandle_t cnv : depot->get_convoy_list()) {
		if (!cnv.is_bound()) {
			continue;
		}
		j.obj();
		j.kv("id", (int)cnv.get_id());
		j.kv("name", cnv->get_name());
		j.key("vehicles").arr();
		for (uint8 i = 0; i < cnv->get_vehicle_count(); i++) {
			j.str(cnv->get_vehicle(i)->get_desc()->get_name());
		}
		j.end_arr();
		j.key("line");
		if (cnv->get_line().is_bound()) {
			j.num(cnv->get_line().get_id());
		}
		else {
			j.null();
		}
		j.end_obj();
	}
	j.end_arr();
	j.key("stored").arr();
	for (vehicle_t *v : depot->get_vehicle_list()) {
		j.str(v->get_desc()->get_name());
	}
	j.end_arr();
	return NULL;
}


/**
 * agent: depot_op player=N x,y[,z] op=<a|i|b|d|v|s> convoy=<id> vehicle=<name>
 *  a / i  append / insert vehicle `vehicle` (with the vehicles it must be coupled with, which the depot buys together)
 *         to convoy `convoy`; convoy=0 makes a new convoy, single player: "convoy":<its id> in the reply
 *  b start convoy `convoy`; d disassemble it into the depot; v sell it; s sell the stored vehicle `vehicle`
 * The depot and the convoy belong to the company and the convoy is in this depot; the vehicle fits the depot, is
 * available now (not future, not obsolete), can be coupled and the convoy does not get too long. The depot tool fails
 * without a message, so all this is checked first.
 */
static const char *cmd_depot_op(const args_t &a, json_t &j)
{
	player_t *player;
	if (const char *err = get_agent_player(a, player)) {
		return err;
	}
	depot_t *depot;
	if (const char *err = find_depot(a, depot)) {
		return err;
	}
	const koord3d dpos = depot->get_pos();
	if (depot->get_owner() != player) {
		return agent_error("the depot at %s belongs to %s", pos_text(dpos).c_str(), owner_text(depot->get_owner_nr()).c_str());
	}
	const std::string op = arg_str(a, "op");
	if (op.size() != 1  ||  strchr("aibdvs", op[0]) == NULL) {
		return "op must be a (append), i (insert), b (start), d (disassemble), v (sell convoy) or s (sell stored vehicle)";
	}
	const char c = op[0];

	sint64 cnv_id = 0;
	if (has_arg(a, "convoy")  &&  !arg_str(a, "convoy").empty()  &&  !agent_number(a, "convoy", cnv_id)) {
		return "convoy=<id> must be a number";
	}
	convoihandle_t cnv;
	if (c != 's'  &&  cnv_id != 0) {
		cnv = handle_of<convoi_t>(cnv_id);
		if (!cnv.is_bound()) {
			return "no convoy with this id";
		}
		if (cnv->get_owner() != player) {
			return agent_error("convoy %d belongs to %s", (int)cnv_id, owner_text(cnv->get_owner() ? cnv->get_owner()->get_player_nr() : -1).c_str());
		}
		if (!depot->get_convoy_list().is_contained(cnv)) {
			return agent_error("convoy %d is not in the depot at %s", (int)cnv_id, pos_text(dpos).c_str());
		}
	}
	else if (c == 'b'  ||  c == 'd'  ||  c == 'v') {
		return "convoy=<id> of a convoy in this depot is required";
	}

	const vehicle_desc_t *desc = NULL;
	if (c == 'a'  ||  c == 'i'  ||  c == 's') {
		const std::string name = arg_str(a, "vehicle");
		if (name.empty()) {
			return "vehicle=<name> is required";
		}
		desc = vehicle_builder_t::get_info(name.c_str());
		if (desc == NULL) {
			return make_error("no vehicle named '%s'", name.c_str());
		}
		if (desc->get_waytype() != depot->get_waytype()) {
			return agent_error("vehicle '%s' (%s) does not fit this depot (%s)", desc->get_name(), waytype_name(desc->get_waytype()), waytype_name(depot->get_waytype()));
		}
	}

	cbuffer_t param;
	switch (c) {
		case 'a':
		case 'i': {
			// the vehicles the depot tool buys together (tool_change_depot_t::init)
			slist_tpl<const vehicle_desc_t *> chain;
			const vehicle_desc_t *info = desc;
			if (c != 'a') {
				while (info->get_leader_count() == 1  &&  info->get_leader(0) != NULL  &&  info->get_leader(0) != vehicle_desc_t::any_vehicle  &&  !chain.is_contained(info->get_leader(0))) {
					info = info->get_leader(0);
					chain.insert(info);
				}
				info = desc;
			}
			chain.append(info);
			if (c != 'i') {
				while (info->get_trailer_count() == 1  &&  info->get_trailer(0) != NULL  &&  info->get_trailer(0) != vehicle_desc_t::any_vehicle  &&  !chain.is_contained(info->get_trailer(0))) {
					info = info->get_trailer(0);
					chain.append(info);
				}
			}
			for (const vehicle_desc_t *v : chain) {
				if (const char *err = agent_check_available(v, "vehicle", v->get_name())) {
					return err;
				}
			}
			const uint32 count_now = cnv.is_bound() ? cnv->get_vehicle_count() : 0;
			if (count_now + chain.get_count() > depot->get_max_convoi_length()) {
				return agent_error("the convoy would get too long for this depot: %u + %u vehicles, at most %u", count_now, chain.get_count(), depot->get_max_convoi_length());
			}
			if (count_now > 0) {
				// only couplings the depot window offers
				if (c == 'a') {
					const vehicle_desc_t *last = cnv->get_vehicle(count_now - 1)->get_desc();
					const vehicle_desc_t *first = chain.front();
					if (!last->can_lead(first)  ||  !first->can_follow(last)) {
						return agent_error("vehicle '%s' cannot be coupled behind '%s'", first->get_name(), last->get_name());
					}
				}
				else {
					const vehicle_desc_t *first = cnv->get_vehicle(0)->get_desc();
					const vehicle_desc_t *last = chain.back();
					if (!last->can_lead(first)  ||  !first->can_follow(last)) {
						return agent_error("vehicle '%s' cannot be coupled in front of '%s'", last->get_name(), first->get_name());
					}
				}
			}
			else if (!cnv.is_bound()  &&  convoihandle_t::is_exhausted()) {
				return "Convoi handles exhausted!";
			}
			param.printf("%c,%s,%u,%s", c, dpos.get_str(), (unsigned)cnv_id, desc->get_name());
			break;
		}
		case 'b':
			if (cnv->get_vehicle_count() == 0) {
				return agent_error("convoy %d has no vehicles", (int)cnv_id);
			}
			if (cnv->get_schedule() == NULL  ||  cnv->get_schedule()->empty()) {
				return agent_error("convoy %d has no schedule: give it a line (convoy_op op=l) or a schedule (convoy_op op=g) first", (int)cnv_id);
			}
			param.printf("b,%s,%u", dpos.get_str(), (unsigned)cnv_id);
			break;
		case 'd':
		case 'v':
			param.printf("%c,%s,%u", c, dpos.get_str(), (unsigned)cnv_id);
			break;
		case 's': {
			bool stored = false;
			for (vehicle_t *v : depot->get_vehicle_list()) {
				stored |= v->get_desc() == desc;
			}
			if (!stored) {
				return make_error("no vehicle '%s' is stored in this depot", desc->get_name());
			}
			param.printf("s,%s,0,%s", dpos.get_str(), desc->get_name());
			break;
		}
	}

	vector_tpl<uint16> before;
	for (convoihandle_t const &d : depot->get_convoy_list()) {
		before.append(d.get_id());
	}
	const uint32 vehicles_before = cnv.is_bound() ? cnv->get_vehicle_count() : 0;
	bool suspended = false;
	if (const char *err = agent_simple_tool(TOOL_CHANGE_DEPOT, param, player, suspended)) {
		return err;
	}
	agent_reply(j, suspended);
	if (!suspended) {
		// single player: done, check the result
		if ((c == 'a'  ||  c == 'i')) {
			convoihandle_t result = cnv;
			if (!cnv.is_bound()) {
				for (convoihandle_t const &d : depot->get_convoy_list()) {
					if (!before.is_contained(d.get_id())) {
						result = d;
					}
				}
			}
			if (!result.is_bound()  ||  result->get_vehicle_count() <= vehicles_before) {
				return "the vehicle was not added";
			}
			j.kv("convoy", (int)result.get_id());
			j.kv("vehicles", (int)result->get_vehicle_count());
		}
		else if (c == 'b'  &&  depot->get_convoy_list().is_contained(cnv)) {
			return agent_error("convoy %d did not start (no route to its first stop, or the scenario forbids it)", (int)cnv_id);
		}
	}
	return NULL;
}


/// line type (= schedule type) from waytype=<1..8 | road rail water air monorail tram maglev narrowgauge>, 0 if invalid
static int parse_linetype(const std::string &s)
{
	char *end = NULL;
	const long v = strtol(s.c_str(), &end, 10);
	if (!s.empty()  &&  *end == 0) {
		return (v >= simline_t::truckline  &&  v <= simline_t::narrowgaugeline) ? (int)v : 0;
	}
	static const struct { const char *name; int type; } names[] = {
		{ "road", simline_t::truckline }, { "rail", simline_t::trainline }, { "track", simline_t::trainline },
		{ "train", simline_t::trainline }, { "water", simline_t::shipline }, { "ship", simline_t::shipline },
		{ "air", simline_t::airline }, { "monorail", simline_t::monorailline }, { "tram", simline_t::tramline },
		{ "maglev", simline_t::maglevline }, { "narrowgauge", simline_t::narrowgaugeline }
	};
	for (auto const &n : names) {
		if (s == n.name) {
			return n.type;
		}
	}
	return 0;
}


static schedule_t *agent_new_schedule(int type)
{
	switch (type) {
		case schedule_t::truck_schedule:       return new truck_schedule_t();
		case schedule_t::train_schedule:       return new train_schedule_t();
		case schedule_t::ship_schedule:        return new ship_schedule_t();
		case schedule_t::airplane_schedule:    return new airplane_schedule_t();
		case schedule_t::monorail_schedule:    return new monorail_schedule_t();
		case schedule_t::tram_schedule:        return new tram_schedule_t();
		case schedule_t::maglev_schedule:      return new maglev_schedule_t();
		case schedule_t::narrowgauge_schedule: return new narrowgauge_schedule_t();
		default:                               return NULL;
	}
}


static bool parse_long(const char *&p, long &v)
{
	char *end = NULL;
	v = strtol(p, &end, 10);
	if (end == p) {
		return false;
	}
	p = end;
	return true;
}


/**
 * Checks a schedule for an agent: engine format <current stop>|<type>|<x>,<y>,<z>,<min load>,<wait>|...| with this
 * type, every stop on an existing ground where this kind of vehicle can stop and that the company may use (as the
 * schedule window checks it: no ways or depots of other companies, only stops it may use), minimum load 0..100, at
 * least two different stops (allow_empty: or none), and the scenario rule (as scenario_check_schedule). text becomes
 * the schedule as the engine reads it, which is sent to the tool.
 */
static const char *agent_check_schedule(const player_t *player, int type, std::string &text, bool allow_empty)
{
	karte_t *welt = world();
	if (text.size() > 16384) {
		return "schedule too long";
	}
	// strict syntax first: the engine reads schedules with atoi and fails quietly
	const char *p = text.c_str();
	long cur, t;
	if (!parse_long(p, cur)  ||  cur < 0  ||  *p++ != '|'  ||  !parse_long(p, t)  ||  *p++ != '|') {
		return "schedule must look like <current stop>|<type>|<x>,<y>,<z>,<min load>,<wait>|... (e.g. 0|1|10,20,0,0,0|30,40,1,0,0|)";
	}
	if (t != type) {
		return agent_error("schedule type %d does not fit: this needs type %d (1 road, 2 train, 3 ship, 4 air, 5 monorail, 6 tram, 7 maglev, 8 narrow gauge)", (int)t, type);
	}
	int stops = 0;
	while (*p) {
		long e[5];
		for (int i = 0; i < 5; i++) {
			if (!parse_long(p, e[i])  ||  *p++ != (i < 4 ? ',' : '|')) {
				return agent_error("schedule entry %d must be <x>,<y>,<z>,<min load>,<wait>|", stops + 1);
			}
		}
		if (!welt->is_within_limits(koord((sint16)e[0], (sint16)e[1]))  ||  e[0] < 0  ||  e[1] < 0  ||  e[2] < -128  ||  e[2] > 127) {
			return agent_error("schedule entry %d: position outside of the map", stops + 1);
		}
		if (e[3] < 0  ||  e[3] > 100) {
			return agent_error("schedule entry %d: minimum load must be 0..100", stops + 1);
		}
		if (e[4] < 0  ||  e[4] > 65535) {
			return agent_error("schedule entry %d: waiting time must be 0..65535", stops + 1);
		}
		if (++stops > 254) {
			return "a schedule has at most 254 stops";
		}
	}
	std::unique_ptr<schedule_t> schedule(agent_new_schedule(type));
	if (!schedule  ||  !schedule->sscanf_schedule(text.c_str())) {
		return "could not read the schedule";
	}
	if (schedule->empty()  &&  !allow_empty) {
		return "a schedule needs at least two different stops";
	}
	for (uint8 i = 0; i < schedule->get_count(); i++) {
		const koord3d pos = schedule->entries[i].pos;
		const grund_t *gr = welt->lookup(pos);
		if (gr == NULL) {
			return agent_error("schedule stop %d: no ground at %s (give the height z of the way)", i + 1, pos_text(pos).c_str());
		}
		if (!schedule->is_stop_allowed(gr)) {
			return agent_error("schedule stop %d at %s: this kind of vehicle cannot stop there (no suitable way)", i + 1, pos_text(pos).c_str());
		}
		// the ownership checks of the schedule window (tool_schedule_insert_aux)
		if (!gr->is_halt()) {
			const weg_t *w = gr->get_weg(schedule->get_waytype());
			if (w == NULL  &&  schedule->get_waytype() == tram_wt) {
				w = gr->get_weg(track_wt);
			}
			if (w  &&  w->get_owner() != welt->get_public_player()  &&  !w->check_owner(player)) {
				return agent_error("schedule stop %d at %s: the way belongs to %s", i + 1, pos_text(pos).c_str(), owner_text(w->get_owner_nr()).c_str());
			}
			if (gr->get_depot()  &&  !gr->get_depot()->check_owner(player)) {
				return agent_error("schedule stop %d at %s: the depot belongs to %s", i + 1, pos_text(pos).c_str(), owner_text(gr->get_depot()->get_owner_nr()).c_str());
			}
		}
		else if (!gr->get_halt()->can_use_halt(player)) {
			return agent_error("schedule stop %d at %s: this company may not use the stop %s", i + 1, pos_text(pos).c_str(), gr->get_halt()->get_name());
		}
	}
	scenario_t *scen = welt->get_scenario();
	if (scen->is_scripted()) {
		if (const char *err = scen->is_schedule_allowed(player, schedule.get())) {
			return *err ? make_error("%s", err) : "Forbidden by scenario";
		}
	}
	cbuffer_t buf;
	schedule->sprintf_schedule(buf);
	text = buf.get_str();
	return NULL;
}


/// the line of an agent command: line=<id> of the company
static const char *get_agent_line(const args_t &a, const player_t *player, linehandle_t &line)
{
	sint64 id = 0;
	if (!agent_number(a, "line", id)) {
		return "line=<id> is required";
	}
	line = handle_of<simline_t>(id);
	if (!line.is_bound()) {
		return "no line with this id";
	}
	if (line->get_owner() != player) {
		return agent_error("line %d belongs to %s", (int)id, owner_text(line->get_owner() ? line->get_owner()->get_player_nr() : -1).c_str());
	}
	return NULL;
}


static const char *get_withdraw_arg(const args_t &a, int &withdraw)
{
	const std::string w = arg_str(a, "withdraw");
	if (w != "0"  &&  w != "1") {
		return "withdraw=0 or withdraw=1 is required";
	}
	withdraw = w == "1";
	return NULL;
}


/**
 * agent: line_op player=N op=c waytype=<1..8|road|rail|water|air|monorail|tram|maglev|narrowgauge> [schedule=<text>]
 *        (single player: "line":<id> of the new line) | op=g line=<id> schedule=<text> | op=d line=<id>
 *        | op=w line=<id> withdraw=0|1 | op=r line=<id> name=<text>
 * The line belongs to the company; schedules are checked (agent_check_schedule). Not offered: t (trim) and u (unite),
 * which change convoys of all companies.
 */
static const char *cmd_line_op(const args_t &a, json_t &j)
{
	player_t *player;
	if (const char *err = get_agent_player(a, player)) {
		return err;
	}
	const std::string op = arg_str(a, "op");
	cbuffer_t param;
	uint16 tool = TOOL_CHANGE_LINE;
	vector_tpl<uint16> lines_before;
	if (op == "c") {
		const int type = parse_linetype(arg_str(a, "waytype"));
		if (type == 0) {
			return "waytype=<1..8 or road, rail, water, air, monorail, tram, maglev, narrowgauge> is required";
		}
		std::string schedule = arg_str(a, "schedule");
		if (schedule.empty()) {
			char empty[16];
			snprintf(empty, sizeof(empty), "0|%d|", type);
			schedule = empty;
		}
		if (const char *err = agent_check_schedule(player, type, schedule, true)) {
			return err;
		}
		param.printf("c,0,%d,0,%s", type, schedule.c_str());
		for (linehandle_t const &l : player->simlinemgmt.get_line_list()) {
			lines_before.append(l.get_id());
		}
	}
	else if (op == "g"  ||  op == "d"  ||  op == "w"  ||  op == "r") {
		linehandle_t line;
		if (const char *err = get_agent_line(a, player, line)) {
			return err;
		}
		const unsigned id = line.get_id();
		if (op == "g") {
			std::string schedule = arg_str(a, "schedule");
			if (schedule.empty()) {
				return "schedule=<text> is required";
			}
			if (const char *err = agent_check_schedule(player, line->get_schedule()->get_type(), schedule, false)) {
				return err;
			}
			param.printf("g,%u,%s", id, schedule.c_str());
		}
		else if (op == "d") {
			param.printf("d,%u", id);
		}
		else if (op == "w") {
			int withdraw;
			if (const char *err = get_withdraw_arg(a, withdraw)) {
				return err;
			}
			if (withdraw  &&  line->count_convoys() == 0) {
				// the engine withdraws only lines with convoys
				return agent_error("line %u has no convoys to withdraw", id);
			}
			param.printf("w,%u,%d", id, withdraw);
		}
		else {
			const std::string name = arg_str(a, "name");
			if (name.empty()  ||  name.size() > 255) {
				return "name=<text> (1..255 bytes) is required";
			}
			for (unsigned char ch : name) {
				if (ch < ' ') {
					return "the name must not contain control characters";
				}
			}
			param.printf("l%u,%s", id, name.c_str());
			tool = TOOL_RENAME;
		}
	}
	else {
		return "op must be c (create), g (schedule), d (delete), w (withdraw) or r (rename)";
	}

	bool suspended = false;
	if (const char *err = agent_simple_tool(tool, param, player, suspended)) {
		return err;
	}
	agent_reply(j, suspended);
	if (!suspended  &&  op == "c") {
		// single player: the new line is the one that was not there before
		linehandle_t created;
		for (linehandle_t const &l : player->simlinemgmt.get_line_list()) {
			if (!lines_before.is_contained(l.get_id())) {
				created = l;
			}
		}
		if (!created.is_bound()) {
			return "the line was not created";
		}
		j.kv("line", (int)created.get_id());
	}
	return NULL;
}


/**
 * agent: convoy_op player=N convoy=<id> op=l line=<id> | op=g schedule=<text> | op=x (sell) | op=d (to the nearest
 * depot) | op=w withdraw=0|1
 * The convoy and the line belong to the company; the schedule type of the line must fit the convoy. op=w sets the
 * given value (the engine tool toggles): when the convoy already has it, nothing is sent ("changed":false); as in the
 * game, an empty convoy that is withdrawn is sold at once, and convoys standing in a depot are not withdrawn (refused).
 */
static const char *cmd_convoy_op(const args_t &a, json_t &j)
{
	player_t *player;
	if (const char *err = get_agent_player(a, player)) {
		return err;
	}
	sint64 id = 0;
	if (!agent_number(a, "convoy", id)) {
		return "convoy=<id> is required";
	}
	convoihandle_t cnv = handle_of<convoi_t>(id);
	if (!cnv.is_bound()) {
		return "no convoy with this id";
	}
	if (cnv->get_owner() != player) {
		return agent_error("convoy %d belongs to %s", (int)id, owner_text(cnv->get_owner() ? cnv->get_owner()->get_player_nr() : -1).c_str());
	}
	// schedule type of the convoy (as convoi_t::create_schedule would make it, without making one)
	int type = 0;
	if (cnv->get_schedule()) {
		type = cnv->get_schedule()->get_type();
	}
	else if (cnv->get_vehicle_count() > 0) {
		type = simline_t::waytype_to_linetype(cnv->front()->get_desc()->get_waytype());
	}

	const std::string op = arg_str(a, "op");
	cbuffer_t param;
	if (op == "l") {
		linehandle_t line;
		if (const char *err = get_agent_line(a, player, line)) {
			return err;
		}
		if (type == 0) {
			return agent_error("convoy %d has no vehicles", (int)id);
		}
		if (line->get_schedule()->get_type() != type) {
			return agent_error("line %d (schedule type %d) does not fit convoy %d (schedule type %d)", (int)line.get_id(), (int)line->get_schedule()->get_type(), (int)id, type);
		}
		param.printf("l,%u,%u", (unsigned)id, (unsigned)line.get_id());
	}
	else if (op == "g") {
		if (type == 0) {
			return agent_error("convoy %d has no vehicles", (int)id);
		}
		std::string schedule = arg_str(a, "schedule");
		if (schedule.empty()) {
			return "schedule=<text> is required";
		}
		if (const char *err = agent_check_schedule(player, type, schedule, false)) {
			return err;
		}
		param.printf("g,%u,%s", (unsigned)id, schedule.c_str());
	}
	else if (op == "x"  ||  op == "d") {
		param.printf("%s,%u", op.c_str(), (unsigned)id);
	}
	else if (op == "w") {
		int withdraw;
		if (const char *err = get_withdraw_arg(a, withdraw)) {
			return err;
		}
		if ((cnv->get_withdraw() ? 1 : 0) == withdraw) {
			j.key("result").null();
			j.kv("changed", false);
			return NULL;
		}
		if (withdraw  &&  cnv->get_state() == convoi_t::INITIAL) {
			// convoi_t::set_withdraw leaves convoys standing in a depot as they are
			const grund_t *gr = world()->lookup(cnv->get_pos());
			if (gr  &&  gr->get_depot()) {
				return agent_error("convoy %d is standing in a depot: the engine does not withdraw it there (sell it with op=x)", (int)id);
			}
		}
		param.printf("w,%u", (unsigned)id);
	}
	else {
		return "op must be l (line), g (schedule), x (sell), d (go to depot) or w (withdraw)";
	}

	bool suspended = false;
	if (const char *err = agent_simple_tool(TOOL_CHANGE_CONVOI, param, player, suspended)) {
		return err;
	}
	agent_reply(j, suspended);
	return NULL;
}


/**
 * agent: plan_way player=N way=<way name> x,y[,z] x2,y2[,z2] [bridge=<name>] [tunnel=<name>] [straight=1]
 * Dry run of tool_build_way: the route the way builder finds (as the tool searches it, with the company as builder) and
 * its price, without building and without changing anything (also in network games: computed here only, never sent).
 * {"ok":true,"tiles":[[x,y,z],...],"length":n,"cost":<money>,"bridges":[[[x,y,z],[x,y,z]],...],
 *  "tunnels":[...],"param":"<param of agent_tool tool_build_way that builds this>"} or {"ok":false,"error":"...",
 *  "reason":"..."} (the same text twice: clients that only look at "ok" and "error" get the reason too);
 * bridges and tunnels are the new ones (start and end square).
 */
static const char *cmd_plan_way(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	player_t *player;
	if (const char *err = get_agent_player(a, player)) {
		return err;
	}
	const std::string way_name = arg_str(a, "way");
	if (way_name.empty()) {
		return "way=<way name> is required";
	}
	const way_desc_t *desc = way_builder_t::get_desc(way_name.c_str(), 0);
	if (const char *err = agent_check_available(desc, "way", way_name.c_str())) {
		return err;
	}
	if (desc->get_styp() == type_river) {
		return "rivers cannot be planned";
	}
	koord3d start, end;
	if (const char *err = get_tile_pos(a, start)) {
		return err;
	}
	if (!has_arg(a, "x2")  ||  !has_arg(a, "y2")) {
		return "missing tile coordinates x2,y2";
	}
	if (const char *err = get_tile_pos(a, end, "x2", "y2", "z2")) {
		return err;
	}
	const std::string bridge_name = arg_str(a, "bridge");
	const std::string tunnel_name = arg_str(a, "tunnel");
	const bridge_desc_t *bridge = NULL;
	const tunnel_desc_t *tunnel = NULL;
	if (!bridge_name.empty()) {
		bridge = bridge_builder_t::get_desc(bridge_name.c_str());
		if (const char *err = agent_check_available(bridge, "bridge", bridge_name.c_str())) {
			return err;
		}
		if (bridge->get_waytype() != desc->get_wtyp()) {
			return make_error("bridge '%s' is not for this way", bridge_name.c_str());
		}
	}
	if (!tunnel_name.empty()) {
		tunnel = tunnel_builder_t::get_desc(tunnel_name.c_str());
		if (const char *err = agent_check_available(tunnel, "tunnel", tunnel_name.c_str())) {
			return err;
		}
		if (tunnel->get_waytype() != desc->get_wtyp()) {
			return make_error("tunnel '%s' is not for this way", tunnel_name.c_str());
		}
	}
	const bool straight = arg_bool(a, "straight", false);

	// the type of construction as tool_build_way_t::calc_route sets it up
	int bautyp = desc->get_wtyp();
	if (desc->is_tram()) {
		bautyp = way_builder_t::schiene_tram;
	}
	const bool elevated = desc->get_styp() == type_elevated  &&  desc->get_wtyp() != air_wt;
	if (elevated) {
		bautyp |= way_builder_t::elevated_flag;
	}
	reply_wrote_ok = true;
	if (desc->get_wtyp() == air_wt  &&  desc->get_styp() == type_runway  &&  player == welt->get_active_player()) {
		// the builder would show a message window for the active player
		const koord s = start.get_2d(), e = end.get_2d();
		if (!(welt->is_within_limits(s - koord(5, 5))  &&  welt->is_within_limits(s + koord(5, 5)))  ||  !(welt->is_within_limits(e - koord(5, 5))  &&  welt->is_within_limits(e + koord(5, 5)))) {
			j.kv("ok", false);
			j.kv("error", "too close to the map edge");
			j.kv("reason", "too close to the map edge");
			return NULL;
		}
	}
	way_builder_t bauigel(player);
	bauigel.init_builder((way_builder_t::bautyp_t)bautyp, desc, tunnel, bridge);
	bauigel.set_keep_existing_faster_ways(true);

	// a parallel way? (tool_build_way_t::calc_route)
	const waytype_t wt = desc->get_wtyp();
	bool assume_parallel = false;
	if (const grund_t *gr = welt->lookup(start)) {
		if (const weg_t *w = gr->get_weg(wt)) {
			if (ribi_t::is_single(w->get_ribi_unmasked())) {
				const koord zv = koord(ribi_t::rotate90(w->get_ribi_unmasked()));
				if (const grund_t *g = welt->lookup(start + zv)) {
					assume_parallel = g->get_weg(wt) != NULL;
				}
				if (const grund_t *g = welt->lookup(start - zv)) {
					assume_parallel |= g->get_weg(wt) != NULL;
				}
			}
		}
		else {
			const koord3d delta_z(0, 0, elevated ? 1 : 0);
			for (int i = 0; i < 8  &&  !assume_parallel; i++) {
				if (const grund_t *g = welt->lookup(start + koord::neighbours[i] + delta_z)) {
					assume_parallel = g->get_weg(wt) != NULL;
				}
			}
		}
	}
	if (assume_parallel) {
		bool assume_parallel2 = false;
		if (const grund_t *gr = welt->lookup(end)) {
			if (!gr->get_weg(wt)) {
				const koord3d delta_z(0, 0, elevated ? 1 : 0);
				for (int i = 0; i < 8  &&  !assume_parallel2; i++) {
					if (const grund_t *g = welt->lookup(end + koord::neighbours[i] + delta_z)) {
						assume_parallel2 = g->get_weg(wt) != NULL;
					}
				}
			}
		}
		assume_parallel &= assume_parallel2;
	}
	bauigel.set_prefer_parallel(assume_parallel);

	const char *err;
	{
		// route search only: no sync step or display in between (the search may call INT_CHECK)
		agent_no_interrupts_t no_interrupts;
		err = straight ? bauigel.calc_straight_route(start, end) : bauigel.calc_route(start, end);
	}
	koord3d_vector_t const &route = bauigel.get_route();
	if (route.get_count() < 2) {
		j.kv("ok", false);
		j.kv("error", err ? err : "no route found");
		j.kv("reason", err ? err : "no route found");
		return NULL;
	}
	// new bridges and tunnels: gaps in the route as way_builder_t::calc_costs counts them
	vector_tpl<koord3d> bridges, tunnels;
	for (uint32 i = 0; i + 1 < route.get_count(); i++) {
		const koord d = (route[i + 1] - route[i]).get_2d();
		if (d.x > 1  ||  d.y > 1  ||  d.x < -1  ||  d.y < -1) {
			const grund_t *s = welt->lookup(route[i]);
			const grund_t *e = welt->lookup(route[i + 1]);
			if (s == NULL  ||  e == NULL  ||  s->get_weg_hang() != s->get_grund_hang()  ||  e->get_weg_hang() != e->get_grund_hang()) {
				continue; // already a bridge or tunnel there
			}
			const bool is_bridge = s->get_grund_hang() == 0  ||  ribi_type(s->get_grund_hang()) == ribi_type(-d);
			if ((is_bridge  &&  bridge == NULL)  ||  (!is_bridge  &&  tunnel == NULL)) {
				j.kv("ok", false);
				j.kv("error", "the route needs a bridge or tunnel, but none was given");
				j.kv("reason", "the route needs a bridge or tunnel, but none was given");
				return NULL;
			}
			vector_tpl<koord3d> &list = is_bridge ? bridges : tunnels;
			list.append(route[i]);
			list.append(route[i + 1]);
		}
	}
	const sint64 cost = bauigel.calc_costs();

	j.kv("ok", true);
	j.key("tiles").arr();
	for (uint32 i = 0; i < route.get_count(); i++) {
		koord3d pos = route[i];
		if (elevated) {
			pos.z += bauigel.get_way_height_offset(welt->lookup(route[i]));
		}
		j.arr().num(pos.x).num(pos.y).num(pos.z).end_arr();
	}
	j.end_arr();
	j.kv("length", (int)route.get_count());
	j.kv("cost", money(cost));
	for (int k = 0; k < 2; k++) {
		vector_tpl<koord3d> &list = k == 0 ? bridges : tunnels;
		j.key(k == 0 ? "bridges" : "tunnels").arr();
		for (uint32 i = 0; i + 1 < list.get_count(); i += 2) {
			j.arr();
			j.arr().num(list[i].x).num(list[i].y).num(list[i].z).end_arr();
			j.arr().num(list[i + 1].x).num(list[i + 1].y).num(list[i + 1].z).end_arr();
			j.end_arr();
		}
		j.end_arr();
	}
	// what agent_tool tool=tool_build_way needs to build the same: straight without replacing ways (not ctrl)
	std::string tool_param = std::string(desc->get_name()) + "," + (straight ? "s" : "");
	if (bridge  ||  tunnel) {
		tool_param += std::string(",0,") + (bridge ? bridge->get_name() : "") + (tunnel ? std::string(",") + tunnel->get_name() : std::string());
	}
	j.kv("param", tool_param.c_str());
	return NULL;
}


/**
 * agent: estimate kind=<way|bridge|tunnel|wayobj|roadsign|station|depot|vehicle> name=<desc name> [count=n] [length=n]
 * [size=XxY] -> {"kind","name","price","maintenance","count","total",...}: price per unit (way, way object, bridge,
 * tunnel: per square, total = price x length x count; station: per square, total = price x X x Y x count; depot,
 * roadsign, vehicle: per piece), maintenance per unit and month. Vehicles add running_cost (per km), fixed_cost (per
 * month), power, speed, capacity, freight, intro_year, obsolete, available. Changes nothing; no player needed.
 */
static const char *cmd_estimate(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const std::string kind = arg_str(a, "kind");
	const std::string name = arg_str(a, "name");
	if (kind.empty()  ||  name.empty()) {
		return "kind=<way|bridge|tunnel|wayobj|roadsign|station|depot|vehicle> and name=<object name> are required";
	}
	sint64 count = 1, length = 1;
	if (has_arg(a, "count")  &&  (!agent_number(a, "count", count)  ||  count < 1  ||  count > 1000000)) {
		return "count must be 1..1000000";
	}
	if (has_arg(a, "length")  &&  (!agent_number(a, "length", length)  ||  length < 1  ||  length > 1000000)) {
		return "length must be 1..1000000";
	}
	const uint16 month = welt->get_timeline_year_month();
	const obj_desc_timelined_t *timeline = NULL;
	const char *desc_name = NULL;
	sint64 price = 0, maintenance = 0, units = 1;
	bool linear = false;
	sint64 sx = 0, sy = 0;
	const vehicle_desc_t *vehicle = NULL;
	if (kind == "way") {
		const way_desc_t *d = way_builder_t::get_desc(name.c_str(), 0);
		if (d) { timeline = d; desc_name = d->get_name(); price = d->get_price(); maintenance = d->get_maintenance(); linear = true; }
	}
	else if (kind == "bridge") {
		const bridge_desc_t *d = bridge_builder_t::get_desc(name.c_str());
		if (d) { timeline = d; desc_name = d->get_name(); price = d->get_price(); maintenance = d->get_maintenance(); linear = true; }
	}
	else if (kind == "tunnel") {
		const tunnel_desc_t *d = tunnel_builder_t::get_desc(name.c_str());
		if (d) { timeline = d; desc_name = d->get_name(); price = d->get_price(); maintenance = d->get_maintenance(); linear = true; }
	}
	else if (kind == "wayobj") {
		const way_obj_desc_t *d = wayobj_t::find_desc(name.c_str());
		if (d) { timeline = d; desc_name = d->get_name(); price = d->get_price(); maintenance = d->get_maintenance(); linear = true; }
	}
	else if (kind == "roadsign") {
		const roadsign_desc_t *d = roadsign_t::find_desc(name.c_str());
		if (d) { timeline = d; desc_name = d->get_name(); price = d->get_price(); maintenance = d->get_maintenance(); }
	}
	else if (kind == "station"  ||  kind == "depot") {
		const building_tile_desc_t *tile = hausbauer_t::find_tile(name.c_str(), 0);
		const building_desc_t *d = tile ? tile->get_desc() : NULL;
		if (d  &&  kind == "depot"  &&  !d->is_depot()) {
			return make_error("'%s' is not a depot", name.c_str());
		}
		if (d  &&  kind == "station"  &&  (!d->is_transport_building()  ||  d->is_depot())) {
			return make_error("'%s' is not a stop or station building", name.c_str());
		}
		if (d) {
			timeline = d;
			desc_name = d->get_name();
			price = d->get_price(welt);
			maintenance = d->get_maintenance(welt);
			if (kind == "station") {
				sx = d->get_x();
				sy = d->get_y();
				const std::string size = arg_str(a, "size");
				if (!size.empty()) {
					long x = 0, y = 0;
					char rest = 0;
					if (sscanf(size.c_str(), "%ldx%ld%c", &x, &y, &rest) != 2  ||  x < 1  ||  y < 1  ||  x > 64  ||  y > 64) {
						return "size must be XxY, e.g. 1x3";
					}
					sx = x;
					sy = y;
				}
				units = sx * sy;
			}
		}
	}
	else if (kind == "vehicle") {
		vehicle = vehicle_builder_t::get_info(name.c_str());
		if (vehicle) { timeline = vehicle; desc_name = vehicle->get_name(); price = vehicle->get_price(); maintenance = vehicle->get_fixed_cost(); }
	}
	else {
		return "kind must be way, bridge, tunnel, wayobj, roadsign, station, depot or vehicle";
	}
	if (timeline == NULL) {
		return agent_error("no %s named '%s'", kind.c_str(), name.c_str());
	}
	if (linear) {
		units = length;
	}
	j.kv("kind", kind.c_str());
	j.kv("name", desc_name);
	j.kv("price", money(price));
	j.kv("maintenance", money(welt->scale_with_month_length(maintenance)));
	j.kv("count", count);
	j.kv("total", money(price * units * count));
	if (linear) {
		j.kv("length", length);
	}
	if (kind == "station") {
		j.key("size").arr().num(sx).num(sy).end_arr();
	}
	if (vehicle) {
		j.kv("running_cost", money(vehicle->get_running_cost()));
		j.kv("fixed_cost", money(welt->scale_with_month_length(vehicle->get_fixed_cost())));
		j.kv("power", (uint32)vehicle->get_power());
		j.kv("speed", (int)vehicle->get_topspeed());
		j.kv("capacity", (int)vehicle->get_capacity());
		const goods_desc_t *freight = vehicle->get_freight_type();
		j.kv("freight", freight ? freight->get_name() : NULL);
		j.kv("waytype", waytype_name(vehicle->get_waytype()));
		j.kv("intro_year", (int)(vehicle->get_intro_year_month() / 12));
		j.kv("obsolete", vehicle->is_retired(month));
	}
	j.kv("available", timeline->is_available(month));
	return NULL;
}


enum command_kind_t
{
	CMD_READ,       ///< only reads the game and the GUI, allowed with -remote_control_readonly
	CMD_READ_HEAVY, ///< like CMD_READ, but takes milliseconds: at most one per poll (see execute_requests)
	CMD_TIME,       ///< pauses or speeds up the game: with -remote_control_readonly only with -remote_control_time
	CMD_ACTION,     ///< changes the game, the GUI or files (input, view, scripts, screenshots, ...)
	CMD_AGENT       ///< agent commands for one company: with -remote_control_readonly only with -remote_control_agent
};

struct command_t
{
	const char *name;
	command_fn fn;
	command_kind_t kind;
};

// events (protocol 2), below with the connections
static const char *cmd_subscribe(const args_t &a, json_t &j);
static const char *cmd_unsubscribe(const args_t &a, json_t &j);

static const command_t commands[] = {
	{ "ping",         cmd_ping,         CMD_READ },
	{ "status",       cmd_status,       CMD_READ },
	{ "windows",      cmd_windows,      CMD_READ },
	{ "click",        cmd_click,        CMD_ACTION },
	{ "move",         cmd_move,         CMD_ACTION },
	{ "drag",         cmd_drag,         CMD_ACTION },
	{ "wheel",        cmd_wheel,        CMD_ACTION },
	{ "key",          cmd_key,          CMD_ACTION },
	{ "text",         cmd_text,         CMD_ACTION },
	{ "screenshot",   cmd_screenshot,   CMD_ACTION },
	{ "view",         cmd_view,         CMD_ACTION },
	{ "tile_at",      cmd_tile_at,      CMD_READ },
	{ "screen_pos",   cmd_screen_pos,   CMD_READ },
	{ "tile",         cmd_tile,         CMD_READ },
	{ "messages",     cmd_messages,     CMD_READ },
	{ "pause",        cmd_pause,        CMD_TIME },
	{ "fast_forward", cmd_fast_forward, CMD_TIME },
	{ "zoom",         cmd_zoom,         CMD_ACTION },
	{ "eval",         cmd_eval,         CMD_ACTION },
	{ "map",          cmd_map,          CMD_READ },
	{ "players",      cmd_players,      CMD_READ },
	{ "cash",         cmd_cash,         CMD_ACTION },
	{ "cities",       cmd_cities,       CMD_READ },
	{ "stations",     cmd_stations,     CMD_READ },
	{ "station",      cmd_station,      CMD_READ },
	{ "convoys",      cmd_convoys,      CMD_READ },
	{ "lines",        cmd_lines,        CMD_READ },
	{ "line",         cmd_line,         CMD_READ },
	{ "convoy",       cmd_convoy,       CMD_READ },
	{ "line_route",   cmd_line_route,   CMD_READ },
	{ "finance",      cmd_finance,      CMD_READ },
	{ "factories",    cmd_factories,    CMD_READ },
	{ "city",         cmd_city,         CMD_READ },
	{ "factory",      cmd_factory,      CMD_READ },
	{ "supply_chain", cmd_supply_chain, CMD_READ },
	{ "goods",        cmd_goods,        CMD_READ },
	{ "world_stats",  cmd_world_stats,  CMD_READ },
	{ "positions",    cmd_positions,    CMD_READ },
	{ "poll",         cmd_poll,         CMD_READ },
	{ "tool",         cmd_tool,         CMD_ACTION },
	{ "toolbars",     cmd_toolbars,     CMD_READ },
	{ "tool_visibility", cmd_tool_visibility, CMD_ACTION },
	{ "unlock_game",  cmd_unlock_game,  CMD_ACTION },
	{ "remove_password", cmd_remove_password, CMD_ACTION },
	{ "palette",      cmd_palette,      CMD_READ },
	{ "minimap",      cmd_minimap,      CMD_READ },
	{ "map_changes",  cmd_map_changes,  CMD_READ },
	{ "labels",       cmd_labels,       CMD_READ },
	{ "desc_list",    cmd_desc_list,    CMD_READ_HEAVY },
	{ "scene3d",      cmd_scene3d,      CMD_READ_HEAVY },
	{ "heights",      cmd_heights,      CMD_READ_HEAVY },
	{ "vehicles3d",   cmd_vehicles3d,   CMD_READ },
	{ "subscribe",    cmd_subscribe,    CMD_READ },
	{ "unsubscribe",  cmd_unsubscribe,  CMD_READ },
	{ "depot",        cmd_depot,        CMD_READ },
	{ "agent_tool",   cmd_agent_tool,   CMD_AGENT },
	{ "depot_op",     cmd_depot_op,     CMD_AGENT },
	{ "line_op",      cmd_line_op,      CMD_AGENT },
	{ "convoy_op",    cmd_convoy_op,    CMD_AGENT },
	{ "plan_way",     cmd_plan_way,     CMD_AGENT },
	{ "estimate",     cmd_estimate,     CMD_AGENT },
};

/// -remote_control_readonly: only CMD_READ and CMD_READ_HEAVY commands
static bool read_only = false;
/// -remote_control_time: CMD_TIME commands also with -remote_control_readonly
static bool time_control = false;
/// -remote_control_agent: CMD_AGENT commands also with -remote_control_readonly
static bool agent_mode = false;


static const command_t *find_command(const std::string &name)
{
	for (command_t const &cmd : commands) {
		if (name == cmd.name) {
			return &cmd;
		}
	}
	return NULL;
}


/// the request is heavy: a CMD_READ_HEAVY command, plan_way (route search), or vehicles3d with extras=1 (searches up
/// to 65536 squares)
static bool is_heavy_request(const std::string &line)
{
	const size_t space = line.find(' ');
	const command_t *cmd = find_command(line.substr(0, space));
	if (cmd  &&  cmd->fn == cmd_plan_way) {
		return true;
	}
	if (cmd  &&  cmd->fn == cmd_vehicles3d  &&  space != std::string::npos) {
		args_t args;
		parse_args(line.substr(space + 1), args);
		return arg_bool(args, "extras", false);
	}
	return cmd  &&  cmd->kind == CMD_READ_HEAVY;
}


/// executes one request line, the reply (without newline) is written to j
static void execute_request(const std::string &line, json_t &j)
{
	const size_t space = line.find(' ');
	const std::string name = line.substr(0, space);
	args_t args;
	if (space != std::string::npos) {
		parse_args(line.substr(space + 1), args);
	}

	j.obj();
	// rid=<text> is echoed in the reply, so clients can match replies to requests
	args_t::iterator rid = args.find("rid");
	if (rid != args.end()) {
		j.kv("rid", rid->second.c_str());
	}
	// %00 decodes to a NUL byte: the commands read values as C strings, so "4124%00x" would act as "4124"
	bool has_nul = false;
	for (args_t::const_iterator it = args.begin(); it != args.end()  &&  !has_nul; ++it) {
		has_nul = it->first.find('\0') != std::string::npos  ||  it->second.find('\0') != std::string::npos;
	}
	if (rid != args.end()) {
		args.erase(rid);
	}
	const char *err = "unknown command";
	reply_wrote_ok = false;
	if (has_nul) {
		err = "arguments must not contain NUL characters";
	}
	else if (world() == NULL) {
		err = "no world loaded";
	}
	else if (const command_t *cmd = find_command(name)) {
		if (read_only  &&  cmd->kind == CMD_AGENT  &&  !agent_mode) {
			err = "read-only remote control: agent commands need -remote_control_agent";
		}
		else if (read_only  &&  (cmd->kind == CMD_ACTION  ||  (cmd->kind == CMD_TIME  &&  !time_control))) {
			err = "read-only remote control";
		}
		else {
			err = cmd->fn(args, j);
		}
	}
	if (err) {
		j.kv("ok", false);
		j.kv("error", err);
	}
	else if (!reply_wrote_ok) {
		j.kv("ok", true);
	}
	j.end_obj();
}


// ---------------------------------------------------------------------------
// sockets
// ---------------------------------------------------------------------------

/// event topics (protocol 2)
enum event_topic_t
{
	TOPIC_MESSAGES, ///< hook: every new message
	TOPIC_MONTH,    ///< hook: new month
	TOPIC_WORLD,    ///< hook: world loaded, created or closed
	TOPIC_STATUS,   ///< watcher: pause, fast forward, time multiplier, active player
	TOPIC_CASH,     ///< watcher: cash and net wealth of the players
	TOPIC_CONVOYS,  ///< watcher: convoy states, added and removed convoys
	TOPIC_ARRIVALS, ///< hook, collected per interval: convoys arrived at stops
	TOPIC_COUNT
};

static const char *const topic_names[TOPIC_COUNT] = {
	"messages", "month", "world", "status", "cash", "convoys", "arrivals"
};

#define TOPIC_BIT(t) (1u << (t))
#define ALL_TOPICS ((1u << TOPIC_COUNT) - 1)
/// topics recorded by hooks in the engine (the others are compared by watchers in the polls)
#define HOOK_TOPICS (TOPIC_BIT(TOPIC_MESSAGES) | TOPIC_BIT(TOPIC_MONTH) | TOPIC_BIT(TOPIC_WORLD) | TOPIC_BIT(TOPIC_ARRIVALS))

#define EVENT_RING_SIZE 2048             ///< events kept until all clients got them (power of 2)
#define EVENT_RING_BYTES (4*1024*1024)   ///< ... and at most this many bytes of them
#define EVENT_OUTPUT_LIMIT (1024*1024)   ///< events are passed to a client only while less output waits
#define EVENTS_PER_POLL 256              ///< events passed to a client per poll
#define DEFAULT_EVENT_INTERVAL 1000      ///< ms between two watcher events of a topic
#define MIN_EVENT_INTERVAL 250
#define MAX_EVENT_INTERVAL 3600000
#define MAX_ARRIVALS 8192                ///< arrivals collected per client and interval
#define CONVOY_IDS 65536                 ///< convoy handle ids are 16 bit
#define NO_CONVOY 0xFF                   ///< convoy_state of an id without convoy

/// what a client subscribed and the state of its watchers
struct subscription_t
{
	uint32 topics = 0;
	uint64 from[TOPIC_COUNT] = {}; ///< events of a topic are delivered only with a larger seq (time of subscribe)
	uint32 interval = DEFAULT_EVENT_INTERVAL;
	sint16 player = -1;            ///< cash: only this player, -1 all
	uint64 next_seq = 0;           ///< next event in the ring to deliver
	uint32 lost = 0;               ///< events for this client dropped from the ring before delivery
	uint64 lost_seq = 0;           ///< seq of the newest of them

	uint32 world_gen = 0;          ///< world generation of the watcher state below
	uint32 last_watch = 0;         ///< dr_time() of the last cash/convoys/arrivals comparison
	uint32 last_status = 0;        ///< dr_time() of the last status event

	// status
	bool paused = false, ff = false;
	sint32 mult = 0;
	int player_nr = -1;

	// cash
	bool has_player[MAX_PLAYER_COUNT] = {};
	sint64 cash[MAX_PLAYER_COUNT] = {};
	sint64 wealth[MAX_PLAYER_COUNT] = {};

	// convoys
	std::vector<uint8> convoy_state; ///< state by convoy id, NO_CONVOY = none
	std::vector<uint8> convoy_seen;  ///< epoch of the last comparison that found the convoy
	std::vector<uint16> convoy_ids;  ///< convoys of the last comparison
	uint8 convoy_epoch = 0;

	// arrivals
	std::vector<uint16> arrivals;    ///< pairs convoy id, halt id
	uint32 arrivals_dropped = 0;
};

struct remote_client_t
{
	SOCKET sock;
	uint32 id;           ///< unique, addresses events of watchers to this client
	int protocol;        ///< protocol of the greeting, 0 before
	std::unique_ptr<subscription_t> sub; ///< subscribed events, NULL if none
	std::string inbuf;   ///< received data, the next request starts at inpos
	size_t inpos;
	size_t scanned;      ///< inbuf has no newline between inpos and scanned
	std::string outbuf;  ///< replies, the unsent part starts at outpos
	size_t outpos;
	uint32 last_output;  ///< dr_time() when replies became pending or were last partly sent
	uint32 accepted;     ///< dr_time() of accept, for the handshake timeout
	bool greeted;
	bool closing;        ///< closed at the end of the poll

	bool output_pending() const { return outpos < outbuf.size(); }
};

static SOCKET listen_socket = INVALID_SOCKET;
static std::vector<remote_client_t> clients;
static bool in_poll = false;
static uint32 next_client_id = 1;
/// the client whose request is executed (for subscribe and unsubscribe)
static remote_client_t *current_client = NULL;


static bool set_nonblocking(SOCKET s, bool on)
{
#if USE_WINSOCK
	u_long mode = on ? 1 : 0;
	return ioctlsocket(s, FIONBIO, &mode) == 0;
#else
	int flags = fcntl(s, F_GETFL, 0);
	if (flags < 0) {
		return false;
	}
	flags = on ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
	return fcntl(s, F_SETFL, flags) == 0;
#endif
}


static bool would_block()
{
	const int err = GET_LAST_ERROR();
#if USE_WINSOCK
	return err == WSAEWOULDBLOCK;
#else
	return err == EWOULDBLOCK || err == EAGAIN || err == EINTR;
#endif
}


/// sends as much of the pending output as the socket takes without waiting, false if the connection broke
static bool flush_client(remote_client_t &c)
{
	while (c.output_pending()) {
#ifdef MSG_NOSIGNAL
		const int flags = MSG_NOSIGNAL;
#else
		const int flags = 0;
#endif
		const size_t remaining = c.outbuf.size() - c.outpos;
		const int chunk = (int)(remaining < 262144 ? remaining : 262144);
		const int n = (int)send(c.sock, c.outbuf.data() + c.outpos, chunk, flags);
		if (n > 0) {
			c.outpos += n;
			c.last_output = dr_time();
			continue;
		}
		if (n < 0  &&  would_block()) {
			return true; // the rest is sent in the next polls
		}
		return false;
	}
	if (c.outbuf.capacity() > 4 * 1024 * 1024) {
		std::string().swap(c.outbuf); // free the memory of a large reply
	}
	c.outbuf.clear();
	c.outpos = 0;
	return true;
}


/// appends a reply line and starts sending it, false if the connection must be closed
static bool queue_reply(remote_client_t &c, json_t &j)
{
	std::string &reply = j.text();
	if (c.outbuf.size() - c.outpos + reply.size() + 1 > MAX_PENDING_OUTPUT) {
		dbg->warning("remote_control", "closing connection: more than %d bytes of replies not read", MAX_PENDING_OUTPUT);
		return false;
	}
	reply += '\n';
	if (!c.output_pending()) {
		// nothing waits: take over the reply instead of copying it
		c.outbuf.swap(reply);
		c.outpos = 0;
		c.last_output = dr_time();
	}
	else {
		c.outbuf.append(reply);
	}
	return flush_client(c);
}


/// appends text (complete lines) to the output of a client, sent by the next flush_client()
static void append_output(remote_client_t &c, const char *text, size_t len)
{
	if (!c.output_pending()) {
		c.outbuf.clear();
		c.outpos = 0;
		c.last_output = dr_time();
	}
	c.outbuf.append(text, len);
}


// ---------------------------------------------------------------------------
// events (protocol 2)
//
// Hooks in the engine (messages, month, world, arrivals) and the watchers of the subscribed
// clients (status, cash, convoys, arrivals per interval) store complete event lines in a ring.
// Every poll passes the new events to the clients that subscribed them, between whole replies.
// The hooks only write to memory of the remote control: no I/O, no random numbers, no change of
// the game, so they are safe in network games. Without a subscribed topic they return at once.
// ---------------------------------------------------------------------------

struct event_record_t
{
	uint64 seq;
	uint32 client;    ///< the only client that gets the event, 0 = every client that subscribed the topic
	uint8 topic;
	std::string line; ///< the event line with line end
};

static std::vector<event_record_t> event_ring; ///< allocated while a client subscribed something
static uint64 event_seq = 0;                   ///< seq of the newest event
static uint64 event_oldest = 1;                ///< seq of the oldest event in the ring
static size_t event_ring_bytes = 0;
static uint32 hook_topics = 0;                 ///< topics with an engine hook that a client subscribed
static json_t event_json;                      ///< the event being built, keeps its memory
static std::vector<uint16> arrivals_pending;   ///< pairs convoy id, halt id since the last poll
static uint32 arrivals_pending_dropped = 0;

// scratch memory of the convoy watcher
static std::vector<uint16> convoy_ids_now, convoy_added, convoy_removed, convoy_changes;


static bool event_wanted(const remote_client_t &c, const event_record_t &r)
{
	const subscription_t *s = c.sub.get();
	return s  &&  (s->topics & TOPIC_BIT(r.topic))  &&  r.seq > s->from[r.topic]  &&  (r.client == 0  ||  r.client == c.id);
}


/// removes the oldest event from the ring; clients that did not get it yet count it as lost
static void drop_oldest_event()
{
	event_record_t &r = event_ring[event_oldest % EVENT_RING_SIZE];
	for (remote_client_t &c : clients) {
		subscription_t *s = c.sub.get();
		if (s  &&  s->next_seq == event_oldest) {
			if (event_wanted(c, r)) {
				s->lost++;
				s->lost_seq = r.seq;
			}
			s->next_seq++;
		}
	}
	event_ring_bytes -= r.line.size();
	if (r.line.capacity() > 4096) {
		std::string().swap(r.line);
	}
	else {
		r.line.clear();
	}
	event_oldest++;
}


/// starts an event line in event_json; the caller writes "data" and calls commit_event()
static json_t &begin_event(int topic)
{
	json_t &j = event_json;
	j.clear();
	j.obj();
	j.kv("event", topic_names[topic]);
	j.kv("seq", (sint64)(event_seq + 1));
	write_date(j, "date", world()->get_current_month());
	return j;
}


/// finishes the event of begin_event() and stores it in the ring (client 0 = for everybody)
static void commit_event(int topic, uint32 client)
{
	event_json.end_obj();
	if (event_ring.empty()) {
		return;
	}
	const uint64 seq = ++event_seq;
	const size_t len = event_json.size() + 1;
	while (event_oldest < seq  &&  (seq - event_oldest >= EVENT_RING_SIZE  ||  event_ring_bytes + len > EVENT_RING_BYTES)) {
		drop_oldest_event();
	}
	event_record_t &r = event_ring[seq % EVENT_RING_SIZE];
	r.seq = seq;
	r.client = client;
	r.topic = (uint8)topic;
	if (r.line.capacity() > 4096  &&  r.line.capacity() > 4 * len) {
		std::string().swap(r.line);
	}
	r.line.assign(event_json.get(), event_json.size());
	r.line += '\n';
	event_ring_bytes += r.line.size();
}


/// after subscriptions changed: which hooks must record, frees the ring when nobody subscribed
static void update_subscriptions()
{
	uint32 topics = 0;
	bool any = false;
	for (remote_client_t const &c : clients) {
		if (c.sub) {
			topics |= c.sub->topics;
			any = true;
		}
	}
	hook_topics = topics & HOOK_TOPICS;
	if (!(hook_topics & TOPIC_BIT(TOPIC_ARRIVALS))) {
		std::vector<uint16>().swap(arrivals_pending);
		arrivals_pending_dropped = 0;
	}
	if (!any  &&  !event_ring.empty()) {
		std::vector<event_record_t>().swap(event_ring);
		event_oldest = event_seq + 1;
		event_ring_bytes = 0;
	}
}


void remote_control_on_message(const message_node_t *node, unsigned int seq)
{
	if (hook_topics & TOPIC_BIT(TOPIC_MESSAGES)) {
		json_t &j = begin_event(TOPIC_MESSAGES);
		j.key("data");
		write_message(j, node, seq);
		commit_event(TOPIC_MESSAGES, 0);
	}
}


void remote_control_on_month(bool year_changed)
{
	if (hook_topics & TOPIC_BIT(TOPIC_MONTH)) {
		json_t &j = begin_event(TOPIC_MONTH);
		j.key("data").obj();
		write_date(j, "date", world()->get_current_month());
		j.kv("year_changed", year_changed);
		j.end_obj();
		commit_event(TOPIC_MONTH, 0);
	}
}


void remote_control_on_world(remote_control_world_event_t what)
{
	if (what != REMOTE_WORLD_CLOSED) {
		remote_control_world_generation++;
	}
	// the squares are about to change or are new
	map_tracking_stop();
	if (what != REMOTE_WORLD_CLOSED  &&  listen_socket != INVALID_SOCKET) {
		get_desc_catalog(); // built once (some ms), better while loading than in a frame of the running game
	}
	karte_t *welt = world();
	if ((hook_topics & TOPIC_BIT(TOPIC_WORLD))  &&  welt) {
		static const char *const names[] = { "loaded", "created", "closed" };
		json_t &j = begin_event(TOPIC_WORLD);
		j.key("data").obj();
		j.kv("event", names[what]);
		j.kv("gen", (uint32)remote_control_world_generation);
		j.kv("size_x", (int)welt->get_size().x);
		j.kv("size_y", (int)welt->get_size().y);
		j.end_obj();
		commit_event(TOPIC_WORLD, 0);
	}
}


void remote_control_on_arrival(unsigned short convoy_id, unsigned short halt_id)
{
	if (hook_topics & TOPIC_BIT(TOPIC_ARRIVALS)) {
		if (arrivals_pending.size() < 2 * MAX_ARRIVALS) {
			arrivals_pending.push_back(convoy_id);
			arrivals_pending.push_back(halt_id);
		}
		else {
			arrivals_pending_dropped++;
		}
	}
}


/// status watcher: compared every poll, at most one event per interval
static void watch_status(subscription_t &s, uint32 client, uint32 now, bool emit)
{
	karte_t *welt = world();
	const bool paused = welt->is_paused();
	const bool ff = fast_forward_on();
	const sint32 mult = welt->get_time_multiplier();
	const int player = welt->get_active_player() ? (int)welt->get_active_player_nr() : -1;
	if (emit) {
		if (paused == s.paused  &&  ff == s.ff  &&  mult == s.mult  &&  player == s.player_nr) {
			return;
		}
		if (now - s.last_status < s.interval) {
			return; // reported when the interval is over
		}
		json_t &j = begin_event(TOPIC_STATUS);
		j.key("data").obj();
		j.kv("paused", paused).kv("ff", ff).kv("mult", (int)mult).kv("player", player);
		j.end_obj();
		commit_event(TOPIC_STATUS, client);
		s.last_status = now;
	}
	s.paused = paused;
	s.ff = ff;
	s.mult = mult;
	s.player_nr = player;
}


/// cash watcher: one event per player whose cash or net wealth changed
static void watch_cash(subscription_t &s, uint32 client, bool emit)
{
	karte_t *welt = world();
	for (int i = 0; i < MAX_PLAYER_COUNT; i++) {
		player_t *player = welt->get_player(i);
		if (player == NULL) {
			s.has_player[i] = false;
			continue;
		}
		finance_t *f = player->get_finance();
		const sint64 cash = f->get_account_balance();
		const sint64 wealth = f->get_netwealth();
		if (s.has_player[i]  &&  cash == s.cash[i]  &&  wealth == s.wealth[i]) {
			continue;
		}
		s.has_player[i] = true;
		s.cash[i] = cash;
		s.wealth[i] = wealth;
		if (emit  &&  (s.player < 0  ||  s.player == i)) {
			json_t &j = begin_event(TOPIC_CASH);
			j.key("data").obj();
			j.kv("player", i).kv("cash", money(cash)).kv("net_wealth", money(wealth));
			j.end_obj();
			commit_event(TOPIC_CASH, client);
		}
	}
}


/// convoy watcher: compares the states of all convoys with the last comparison, O(convoys)
static void watch_convoys(subscription_t &s, uint32 client, bool emit)
{
	if (s.convoy_state.empty()) {
		s.convoy_state.assign(CONVOY_IDS, NO_CONVOY);
		s.convoy_seen.assign(CONVOY_IDS, 0);
	}
	if (++s.convoy_epoch == 0) {
		s.convoy_epoch = 1;
	}
	const uint8 epoch = s.convoy_epoch;
	convoy_ids_now.clear();
	convoy_added.clear();
	convoy_removed.clear();
	convoy_changes.clear();
	for (convoihandle_t cnv : world()->convoys()) {
		if (!cnv.is_bound()) {
			continue;
		}
		const uint16 id = cnv.get_id();
		const uint8 state = (uint8)cnv->get_state();
		const uint8 prev = s.convoy_state[id];
		if (prev == NO_CONVOY) {
			convoy_added.push_back(id);
		}
		else if (prev != state) {
			convoy_changes.push_back(id);
			convoy_changes.push_back(state);
			convoy_changes.push_back(prev);
		}
		s.convoy_state[id] = state;
		s.convoy_seen[id] = epoch;
		convoy_ids_now.push_back(id);
	}
	// convoys of the last comparison that were not found now
	for (uint16 id : s.convoy_ids) {
		if (s.convoy_seen[id] != epoch) {
			convoy_removed.push_back(id);
			s.convoy_state[id] = NO_CONVOY;
		}
	}
	s.convoy_ids.swap(convoy_ids_now);
	if (!emit  ||  (convoy_changes.empty()  &&  convoy_added.empty()  &&  convoy_removed.empty())) {
		return;
	}
	json_t &j = begin_event(TOPIC_CONVOYS);
	j.key("data").obj();
	j.key("changes").arr();
	for (size_t i = 0; i + 2 < convoy_changes.size(); i += 3) {
		j.arr().num(convoy_changes[i]).num(convoy_changes[i + 1]).num(convoy_changes[i + 2]).end_arr();
	}
	j.end_arr();
	j.key("added").arr();
	for (uint16 id : convoy_added) {
		j.num(id);
	}
	j.end_arr();
	j.key("removed").arr();
	for (uint16 id : convoy_removed) {
		j.num(id);
	}
	j.end_arr();
	j.key("states").arr();
	for (int i = 0; i < CONVOY_STATE_COUNT; i++) {
		j.str(convoy_state_name(i));
	}
	j.end_arr();
	j.end_obj();
	commit_event(TOPIC_CONVOYS, client);
}


/// the arrivals collected in this interval as one event
static void emit_arrivals(subscription_t &s, uint32 client)
{
	if (s.arrivals.empty()  &&  s.arrivals_dropped == 0) {
		return;
	}
	json_t &j = begin_event(TOPIC_ARRIVALS);
	j.key("data").obj();
	j.key("items").arr();
	for (size_t i = 0; i + 1 < s.arrivals.size(); i += 2) {
		j.arr().num(s.arrivals[i]).num(s.arrivals[i + 1]).end_arr();
	}
	j.end_arr();
	if (s.arrivals_dropped) {
		j.kv("dropped", s.arrivals_dropped);
	}
	j.end_obj();
	commit_event(TOPIC_ARRIVALS, client);
	s.arrivals.clear();
	s.arrivals_dropped = 0;
}


/// takes the current state as the base of the next comparisons of these topics, without events
static void reset_watchers(subscription_t &s, uint32 topics, uint32 now)
{
	if (topics & TOPIC_BIT(TOPIC_STATUS)) {
		watch_status(s, 0, now, false);
		s.last_status = now - s.interval;
	}
	if (topics & TOPIC_BIT(TOPIC_CASH)) {
		watch_cash(s, 0, false);
	}
	if (topics & TOPIC_BIT(TOPIC_CONVOYS)) {
		watch_convoys(s, 0, false);
	}
	if (topics & TOPIC_BIT(TOPIC_ARRIVALS)) {
		s.arrivals.clear();
		s.arrivals_dropped = 0;
	}
}


static void run_watchers(remote_client_t &c, uint32 now)
{
	subscription_t &s = *c.sub;
	if (s.topics & TOPIC_BIT(TOPIC_ARRIVALS)) {
		const size_t room = 2 * MAX_ARRIVALS - s.arrivals.size();
		const size_t n = arrivals_pending.size() < room ? arrivals_pending.size() : room;
		s.arrivals.insert(s.arrivals.end(), arrivals_pending.begin(), arrivals_pending.begin() + n);
		s.arrivals_dropped += arrivals_pending_dropped + (uint32)((arrivals_pending.size() - n) / 2);
	}
	if (s.world_gen != remote_control_world_generation) {
		// another world: all ids changed, the client refetches everything after the world event
		reset_watchers(s, s.topics, now);
		s.world_gen = remote_control_world_generation;
		s.last_watch = now;
		return;
	}
	if (s.topics & TOPIC_BIT(TOPIC_STATUS)) {
		watch_status(s, c.id, now, true);
	}
	if (now - s.last_watch < s.interval) {
		return;
	}
	s.last_watch = now;
	if (s.topics & TOPIC_BIT(TOPIC_CASH)) {
		watch_cash(s, c.id, true);
	}
	if (s.topics & TOPIC_BIT(TOPIC_CONVOYS)) {
		watch_convoys(s, c.id, true);
	}
	if (s.topics & TOPIC_BIT(TOPIC_ARRIVALS)) {
		emit_arrivals(s, c.id);
	}
}


/// passes the new events to a client, between whole replies, as long as it reads them
static void deliver_events(remote_client_t &c)
{
	subscription_t *s = c.sub.get();
	if (s == NULL  ||  c.closing) {
		return;
	}
	int delivered = 0;
	while (delivered < EVENTS_PER_POLL  &&  c.outbuf.size() - c.outpos < EVENT_OUTPUT_LIMIT) {
		if (s->lost) {
			// the client fell behind: tell it, it must refetch the state
			json_t j;
			j.obj().kv("event", "overflow").kv("seq", (sint64)s->lost_seq);
			if (world()) {
				write_date(j, "date", world()->get_current_month());
			}
			j.key("data").obj().kv("lost", s->lost).end_obj();
			j.end_obj();
			j.text() += '\n';
			append_output(c, j.get(), j.size());
			s->lost = 0;
			delivered++;
			continue;
		}
		if (s->next_seq > event_seq) {
			break;
		}
		const event_record_t &r = event_ring[s->next_seq % EVENT_RING_SIZE];
		s->next_seq++;
		if (event_wanted(c, r)) {
			append_output(c, r.line.data(), r.line.size());
			delivered++;
		}
	}
	if (delivered  &&  !flush_client(c)) {
		c.closing = true;
	}
}


/// watchers and delivery of the events, once per poll
static void process_events()
{
	if (event_ring.empty()) {
		return;
	}
	karte_t *welt = world();
	if (welt  &&  !welt->is_destroying()  &&  welt->get_size().x > 0) {
		const uint32 now = dr_time();
		for (remote_client_t &c : clients) {
			if (c.sub  &&  !c.closing) {
				run_watchers(c, now);
			}
		}
	}
	arrivals_pending.clear();
	arrivals_pending_dropped = 0;
	for (remote_client_t &c : clients) {
		deliver_events(c);
	}
}


/// comma separated topic names, "all" for every topic
static const char *parse_topics(const std::string &list, uint32 &topics)
{
	topics = 0;
	size_t start = 0;
	while (start < list.size()) {
		size_t end = list.find(',', start);
		if (end == std::string::npos) {
			end = list.size();
		}
		std::string name = list.substr(start, end - start);
		name.erase(0, name.find_first_not_of(' '));
		name.erase(name.find_last_not_of(' ') + 1);
		if (name == "all") {
			topics |= ALL_TOPICS;
		}
		else if (!name.empty()) {
			int t = 0;
			while (t < TOPIC_COUNT  &&  name != topic_names[t]) {
				t++;
			}
			if (t == TOPIC_COUNT) {
				return make_error("unknown topic '%s'", name.c_str());
			}
			topics |= TOPIC_BIT(t);
		}
		start = end + 1;
	}
	return topics ? NULL : "no topics given (topics=messages,month,world,status,cash,convoys,arrivals or all)";
}


static void write_topics(json_t &j, uint32 topics)
{
	j.key("topics").arr();
	for (int t = 0; t < TOPIC_COUNT; t++) {
		if (topics & TOPIC_BIT(t)) {
			j.str(topic_names[t]);
		}
	}
	j.end_arr();
}


static const char *const need_protocol_2 = "events need protocol 2 (greeting HELLO simutrans-remote 2)";


/**
 * subscribe topics=<list> [interval=<ms>] [player=<nr>]: adds topics to the events of this
 * connection; interval and player (cash of one player only, -1 all) apply to all its topics.
 */
static const char *cmd_subscribe(const args_t &a, json_t &j)
{
	remote_client_t *c = current_client;
	if (c == NULL  ||  c->protocol < 2) {
		return need_protocol_2;
	}
	uint32 topics;
	if (const char *err = parse_topics(arg_str(a, "topics"), topics)) {
		return err;
	}
	sint64 player = -2;
	if (has_arg(a, "player")) {
		player = arg_str(a, "player") == "all" ? -1 : arg_int(a, "player", -2);
		if (player < -1  ||  player >= MAX_PLAYER_COUNT) {
			return "invalid player";
		}
	}
	const uint32 now = dr_time();
	if (event_ring.empty()) {
		event_ring.resize(EVENT_RING_SIZE);
	}
	if (!c->sub) {
		c->sub.reset(new subscription_t());
		c->sub->next_seq = event_seq + 1;
		c->sub->world_gen = remote_control_world_generation;
		c->sub->last_watch = now;
	}
	subscription_t &s = *c->sub;
	if (has_arg(a, "interval")) {
		s.interval = (uint32)clamp<sint64>(arg_int(a, "interval", DEFAULT_EVENT_INTERVAL), MIN_EVENT_INTERVAL, MAX_EVENT_INTERVAL);
	}
	if (player >= -1) {
		s.player = (sint16)player;
	}
	const uint32 added = topics & ~s.topics;
	for (int t = 0; t < TOPIC_COUNT; t++) {
		if (added & TOPIC_BIT(t)) {
			s.from[t] = event_seq; // events from before this reply are not sent
		}
	}
	s.topics |= topics;
	if (s.world_gen != remote_control_world_generation) {
		reset_watchers(s, s.topics, now);
		s.world_gen = remote_control_world_generation;
		s.last_watch = now;
	}
	else {
		reset_watchers(s, added, now);
	}
	update_subscriptions();

	write_topics(j, s.topics);
	j.kv("seq", (sint64)event_seq);
	j.kv("interval", s.interval);
	j.kv("player", (int)s.player);
	return NULL;
}


/// unsubscribe [topics=<list>|all]: stops events of these topics (default all)
static const char *cmd_unsubscribe(const args_t &a, json_t &j)
{
	remote_client_t *c = current_client;
	if (c == NULL  ||  c->protocol < 2) {
		return need_protocol_2;
	}
	uint32 topics;
	if (const char *err = parse_topics(arg_str(a, "topics", "all"), topics)) {
		return err;
	}
	if (c->sub) {
		subscription_t &s = *c->sub;
		s.topics &= ~topics;
		if (!(s.topics & TOPIC_BIT(TOPIC_CONVOYS))) {
			std::vector<uint8>().swap(s.convoy_state);
			std::vector<uint8>().swap(s.convoy_seen);
			std::vector<uint16>().swap(s.convoy_ids);
		}
		if (!(s.topics & TOPIC_BIT(TOPIC_ARRIVALS))) {
			std::vector<uint16>().swap(s.arrivals);
			s.arrivals_dropped = 0;
		}
		if (s.topics == 0) {
			c->sub.reset(); // undelivered events are dropped
		}
		update_subscriptions();
	}
	write_topics(j, c->sub ? c->sub->topics : 0);
	j.kv("seq", (sint64)event_seq);
	return NULL;
}


bool remote_control_init(int port, bool readonly, bool time, bool agent)
{
	if (listen_socket != INVALID_SOCKET) {
		return true;
	}
	read_only = readonly;
	time_control = time;
	agent_mode = agent;
#if USE_WINSOCK
	WSADATA wsa;
	if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
		dbg->error("remote_control_init", "WSAStartup failed");
		return false;
	}
#endif
	listen_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (listen_socket == INVALID_SOCKET) {
		dbg->error("remote_control_init", "could not create socket");
		return false;
	}
#if !USE_WINSOCK
	int reuse = 1;
	setsockopt(listen_socket, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));
#endif
	sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((uint16)port);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // never reachable from other machines

	if (bind(listen_socket, (sockaddr *)&addr, sizeof(addr)) != 0 || listen(listen_socket, MAX_CLIENTS * 2) != 0 || !set_nonblocking(listen_socket, true)) {
		dbg->error("remote_control_init", "could not listen on 127.0.0.1:%d (error %d)", port, GET_LAST_ERROR());
		network_close_socket(listen_socket);
		listen_socket = INVALID_SOCKET;
		return false;
	}
	dbg->message("remote_control_init", "remote control listening on 127.0.0.1:%d%s%s%s", port, read_only ? " (read-only" : "",
		read_only  &&  time_control ? ", time control" : "", read_only ? (agent_mode ? ", agent)" : ")") : (agent_mode ? " (agent)" : ""));
	return true;
}


bool remote_control_active()
{
	return listen_socket != INVALID_SOCKET;
}


void remote_control_shutdown()
{
	for (remote_client_t &c : clients) {
		network_close_socket(c.sock);
	}
	clients.clear();
	update_subscriptions(); // no hooks record anymore
	map_tracking_stop();
	if (listen_socket != INVALID_SOCKET) {
		network_close_socket(listen_socket);
		listen_socket = INVALID_SOCKET;
	}
	reset_eval_vm();
}


/// reads what the client sent, false if the connection is closed or a request is too long
static bool receive(remote_client_t &c)
{
	// drop the requests executed in the last poll
	if (c.inpos > 0) {
		c.inbuf.erase(0, c.inpos);
		c.scanned = c.scanned > c.inpos ? c.scanned - c.inpos : 0;
		c.inpos = 0;
	}
	char buf[16384];
	while (true) {
		const int n = (int)recv(c.sock, buf, sizeof(buf), 0);
		if (n > 0) {
			c.inbuf.append(buf, n);
			if (c.inbuf.size() > MAX_PENDING_INPUT) {
				// e.g. a client that sends requests without reading the replies
				dbg->warning("remote_control", "closing connection: more than %d bytes of requests waiting", MAX_PENDING_INPUT);
				return false;
			}
			continue;
		}
		if (n == 0  ||  !would_block()) {
			return false; // closed or error
		}
		break;
	}
	if (c.inbuf.size() > MAX_REQUEST_LENGTH  &&  c.inbuf.find('\n', c.scanned) == std::string::npos) {
		dbg->warning("remote_control", "closing connection: request longer than %d bytes", MAX_REQUEST_LENGTH);
		return false;
	}
	return true;
}


/// takes the next complete line (without the line end) from the received data, false if there is none
static bool next_line(remote_client_t &c, std::string &line)
{
	const size_t nl = c.inbuf.find('\n', c.scanned > c.inpos ? c.scanned : c.inpos);
	if (nl == std::string::npos) {
		c.scanned = c.inbuf.size();
		return false;
	}
	if (nl - c.inpos > MAX_REQUEST_LENGTH) {
		dbg->warning("remote_control", "closing connection: request longer than %d bytes", MAX_REQUEST_LENGTH);
		c.closing = true;
		return false;
	}
	size_t end = nl;
	if (end > c.inpos  &&  c.inbuf[end - 1] == '\r') {
		end--;
	}
	line.assign(c.inbuf, c.inpos, end - c.inpos);
	c.inpos = nl + 1;
	return true;
}


/**
 * Handles the greeting or executes the next request of a client, false if no complete line is
 * waiting or the next request is heavy and !allow_heavy (it stays first in the queue).
 */
static bool execute_next(remote_client_t &c, bool allow_heavy, bool &heavy)
{
	std::string line;
	const size_t inpos = c.inpos;
	do {
		if (!next_line(c, line)) {
			return false;
		}
	} while (c.greeted  &&  line.empty());
	heavy = c.greeted  &&  is_heavy_request(line);
	if (heavy  &&  !allow_heavy) {
		c.inpos = inpos;
		return false;
	}

	json_t j;
	if (!c.greeted) {
		// protects against anything else talking to this port, e.g. web pages sending HTTP requests
		const size_t hello_len = strlen(REMOTE_HELLO);
		int protocol = 0;
		if (line.size() == hello_len + 1  &&  line.compare(0, hello_len, REMOTE_HELLO) == 0) {
			protocol = line[hello_len] - '0';
		}
		if (protocol < 1  ||  protocol > REMOTE_PROTOCOL_VERSION) {
			dbg->warning("remote_control", "closing connection with wrong greeting");
			c.closing = true;
			return true;
		}
		c.greeted = true;
		c.protocol = protocol;
		j.obj().kv("ok", true).kv("protocol", protocol).kv("read_only", read_only).kv("time_control", !read_only  ||  time_control)
			.kv("agent", !read_only  ||  agent_mode).end_obj();
	}
	else {
		current_client = &c;
		execute_request(line, j);
		current_client = NULL;
	}
	if (!queue_reply(c, j)) {
		c.closing = true;
	}
	return true;
}


/**
 * Executes waiting requests round-robin: every client gets one request per poll, more until
 * POLL_TIME_BUDGET_US after start. A heavy request (CMD_READ_HEAVY, some ms) runs only within
 * HEAVY_START_US after start and only one per poll; a client whose next request is heavy waits
 * for the next poll, its requests keep their order. The first client changes with every poll, so
 * every client gets the heavy slot in turn. The next request of a client waits until its last
 * reply is sent, so a client that does not read its replies only blocks itself.
 */
static void execute_requests(uint64 start)
{
	static size_t rotation = 0;
	const size_t count = clients.size();
	if (count == 0) {
		return;
	}
	rotation++;
	bool heavy_done = false;
	for (bool first_round = true;  ;  first_round = false) {
		bool executed = false;
		for (size_t k = 0; k < count; k++) {
			const uint64 elapsed = time_us() - start;
			if (!first_round  &&  elapsed >= POLL_TIME_BUDGET_US) {
				return;
			}
			remote_client_t &c = clients[(rotation + k) % count];
			bool heavy = false;
			if (!c.closing  &&  !c.output_pending()  &&  execute_next(c, !heavy_done  &&  elapsed < HEAVY_START_US, heavy)) {
				executed = true;
				heavy_done |= heavy;
			}
		}
		if (!executed) {
			return;
		}
	}
}


void remote_control_poll()
{
	if (listen_socket == INVALID_SOCKET || in_poll) {
		return;
	}
	in_poll = true;
	const uint64 poll_start = time_us();

	// accept new connections
	while (true) {
		sockaddr_in addr;
		socklen_t addr_len = sizeof(addr);
		SOCKET s = accept(listen_socket, (sockaddr *)&addr, &addr_len);
		if (s == INVALID_SOCKET) {
			break;
		}
		if (clients.size() >= MAX_CLIENTS) {
			network_close_socket(s);
			continue;
		}
		set_nonblocking(s, true);
		network_set_socket_nodelay(s);
#ifdef SO_NOSIGPIPE
		// systems without MSG_NOSIGNAL (macOS): a client that closes while a reply is sent must not kill the game
		int nosigpipe = 1;
		setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, (const char *)&nosigpipe, sizeof(nosigpipe));
#endif
		remote_client_t c;
		c.sock = s;
		c.id = next_client_id++;
		c.protocol = 0;
		c.inpos = 0;
		c.scanned = 0;
		c.outpos = 0;
		c.accepted = dr_time();
		c.last_output = c.accepted;
		c.greeted = false;
		c.closing = false;
		clients.push_back(std::move(c));
	}

	// read requests, send what is left of earlier replies
	for (remote_client_t &c : clients) {
		if (!receive(c)  ||  !flush_client(c)) {
			c.closing = true;
		}
	}

	execute_requests(poll_start);

	// events of hooks and watchers to the clients that subscribed them
	process_events();

	const uint32 now = dr_time();
	map_tracking_poll(now, !clients.empty(), poll_start);
	bool subscriber_closed = false;
	for (size_t i = 0; i < clients.size(); ) {
		remote_client_t &c = clients[i];
		if (!c.greeted  &&  now - c.accepted > HANDSHAKE_TIMEOUT) {
			if (!c.closing) {
				dbg->warning("remote_control", "closing connection without greeting");
			}
			c.closing = true;
		}
		if (c.output_pending()  &&  now - c.last_output > OUTPUT_STALL_TIMEOUT  &&  !c.closing) {
			// the client stopped reading its replies
			dbg->warning("remote_control", "closing connection: replies not read for %d seconds", OUTPUT_STALL_TIMEOUT / 1000);
			c.closing = true;
		}
		if (c.closing) {
			network_close_socket(c.sock);
			subscriber_closed |= (bool)c.sub;
			clients.erase(clients.begin() + i);
		}
		else {
			i++;
		}
	}
	if (subscriber_closed) {
		update_subscriptions();
	}
	in_poll = false;
}
