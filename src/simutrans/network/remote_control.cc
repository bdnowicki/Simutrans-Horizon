/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 *
 * Simutrans-Horizon, 2026-11: new file, the -remote_control automation interface
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
#include "../builder/goods_manager.h"
#include "../dataobj/ribi.h"
#include "../dataobj/schedule.h"
#include "../descriptor/building_desc.h"
#include "../descriptor/factory_desc.h"
#include "../descriptor/goods_desc.h"
#include "../descriptor/way_desc.h"
#include "../obj/depot.h"
#include "../obj/field.h"
#include "../obj/gebaeude.h"
#include "../obj/label.h"
#include "../obj/leitung2.h"
#include "../obj/way/weg.h"
#include "../vehicle/vehicle.h"
#include "../script/script.h"
#include "../script/script_loader.h"
#include "../sys/simsys.h"
#include "../utils/cbuffer.h"
#include "../utils/simstring.h"
#include "../tpl/slist_tpl.h"
#include "../tpl/vector_tpl.h"

#include "../../squirrel/squirrel.h"
#include "../../squirrel/sq_extensions.h"

#include <algorithm>
#include <cctype>
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
#define POLL_TIME_BUDGET 8                ///< ms per poll for executing requests (at least one per client)
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
	j.kv("fast_forward", welt->is_fast_forward());
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
	if (env_t::networkmode) {
		return "not available in network games";
	}
	karte_t *welt = world();
	welt->set_pause(arg_bool(a, "on", !welt->is_paused()));
	j.kv("paused", welt->is_paused());
	return NULL;
}


static const char *cmd_fast_forward(const args_t &a, json_t &j)
{
	if (env_t::networkmode) {
		return "not available in network games";
	}
	karte_t *welt = world();
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
		halt = haltestelle_t::get_halt_koord_index(koord((sint16)arg_int(a, "x", 0), (sint16)arg_int(a, "y", 0)));
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
#define MAX_MINIMAP_SAMPLES (1024*1024)

/**
 * Change tracking of the map for map_changes, started by the first minimap or map_changes request.
 * Every square keeps its terrain and owner colour; minimap_t::calc_map_pixel(koord), which the game
 * calls for every changed square (and when a vehicle moves while the minimap is open), compares them
 * and records a change only if one of them changed. A slow background re-check finds the changes
 * that do not go through calc_map_pixel (e.g. owner changes).
 */
struct map_tracking_t
{
	bool active = false;
	uint32 world_gen = 0;           ///< world, rotation and size seen last (tracked or by poll)
	uint8 rotation = 0;
	koord size = koord(0, 0);
	uint32 start_gen = 0;           ///< map gen when the tracking started: older since give full
	koord cells = koord(0, 0);
	std::vector<uint16> sig;        ///< per square: terrain colour << 8 | owner colour
	std::vector<uint32> cell_gen;   ///< per cell: map gen of its last change
	uint32 sweep_next = 0;          ///< next square of the background re-check
	uint32 sweep_time = 0;
	uint32 last_use = 0;            ///< dr_time() of the last minimap, map_changes or poll
};

static map_tracking_t map_track;
static uint32 map_gen = 1; ///< revision of the map: changes, other worlds, rotations (never reset)

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
	map_check_tile(k);
}


static void map_tracking_stop()
{
	map_track.active = false;
	minimap_t::tile_changed_hook = NULL;
	std::vector<uint16>().swap(map_track.sig);
	std::vector<uint32>().swap(map_track.cell_gen);
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
}


/// starts the tracking if needed (one pass over the map)
static void map_tracking_start()
{
	map_tracking_validate();
	map_track.last_use = dr_time();
	if (map_track.active) {
		return;
	}
	const koord size = map_track.size;
	map_track.cells = koord((size.x + MAP_CELL - 1) >> MAP_CELL_SHIFT, (size.y + MAP_CELL - 1) >> MAP_CELL_SHIFT);
	map_track.start_gen = ++map_gen;
	map_track.cell_gen.assign((size_t)map_track.cells.x * map_track.cells.y, map_track.start_gen);
	map_track.sig.resize((size_t)size.x * size.y);
	size_t i = 0;
	koord k;
	for (k.y = 0; k.y < size.y; k.y++) {
		for (k.x = 0; k.x < size.x; k.x++) {
			map_track.sig[i++] = tile_signature(k);
		}
	}
	map_track.sweep_next = 0;
	map_track.sweep_time = dr_time();
	map_track.active = true;
	minimap_t::tile_changed_hook = on_tile_changed;
}


/// called every poll: stops unused tracking, notices other worlds, re-checks some squares
static void map_tracking_poll(uint32 now, bool any_client)
{
	if (!map_track.active) {
		return;
	}
	if (!any_client  ||  world() == NULL  ||  now - map_track.last_use > MAP_TRACK_IDLE_TIMEOUT) {
		map_tracking_stop();
		return;
	}
	map_tracking_validate();
	const uint32 elapsed = now - map_track.sweep_time;
	if (!map_track.active  ||  elapsed < 20) {
		return;
	}
	map_track.sweep_time = now;
	uint32 n = std::min<uint32>(elapsed, 1000) * MAP_SWEEP_TILES_PER_SECOND / 1000;
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
	std::vector<uint8> samples((size_t)(sw * sh));
	uint8 *out = samples.data();
	if (!vehicles  &&  (mode == minimap_t::PLAIN  ||  mode == minimap_t::MAP_OWNER)) {
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
	j.kv("ff", welt->is_fast_forward());
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


enum command_kind_t
{
	CMD_READ,  ///< only reads the game and the GUI, allowed with -remote_control_readonly
	CMD_ACTION ///< changes the game, the GUI or files (input, view, time, scripts, screenshots, ...)
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
	{ "pause",        cmd_pause,        CMD_ACTION },
	{ "fast_forward", cmd_fast_forward, CMD_ACTION },
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
	{ "subscribe",    cmd_subscribe,    CMD_READ },
	{ "unsubscribe",  cmd_unsubscribe,  CMD_READ },
};

/// -remote_control_readonly: only CMD_READ commands
static bool read_only = false;


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
	if (has_nul) {
		err = "arguments must not contain NUL characters";
	}
	else if (world() == NULL) {
		err = "no world loaded";
	}
	else {
		for (command_t const &cmd : commands) {
			if (name == cmd.name) {
				err = (read_only  &&  cmd.kind != CMD_READ) ? "read-only remote control" : cmd.fn(args, j);
				break;
			}
		}
	}
	if (err) {
		j.kv("ok", false);
		j.kv("error", err);
	}
	else {
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
	const bool ff = welt->is_fast_forward();
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


bool remote_control_init(int port, bool readonly)
{
	if (listen_socket != INVALID_SOCKET) {
		return true;
	}
	read_only = readonly;
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
	dbg->message("remote_control_init", "remote control listening on 127.0.0.1:%d%s", port, read_only ? " (read-only)" : "");
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


/// handles the greeting or executes the next request of a client, false if no complete line is waiting
static bool execute_next(remote_client_t &c)
{
	std::string line;
	do {
		if (!next_line(c, line)) {
			return false;
		}
	} while (c.greeted  &&  line.empty());

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
		j.obj().kv("ok", true).kv("protocol", protocol).kv("read_only", read_only).end_obj();
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
 * Executes waiting requests round-robin: every client gets one request per poll, more while
 * the time budget lasts. The next request of a client waits until its last reply is sent,
 * so a client that does not read its replies only blocks itself.
 */
static void execute_requests()
{
	static size_t rotation = 0;
	const size_t count = clients.size();
	if (count == 0) {
		return;
	}
	rotation++;
	const uint32 start = dr_time();
	for (bool first_round = true;  ;  first_round = false) {
		bool executed = false;
		for (size_t k = 0; k < count; k++) {
			if (!first_round  &&  dr_time() - start >= POLL_TIME_BUDGET) {
				return;
			}
			remote_client_t &c = clients[(rotation + k) % count];
			if (!c.closing  &&  !c.output_pending()  &&  execute_next(c)) {
				executed = true;
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

	execute_requests();

	// events of hooks and watchers to the clients that subscribed them
	process_events();

	const uint32 now = dr_time();
	map_tracking_poll(now, !clients.empty());
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
