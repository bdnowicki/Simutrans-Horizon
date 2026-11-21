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
#include "../obj/gebaeude.h"
#include "../obj/label.h"
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
#include <map>
#include <string>
#include <vector>


#define REMOTE_HELLO "HELLO simutrans-remote 1"
#define REMOTE_PROTOCOL_VERSION 1
#define MAX_REQUEST_LENGTH (4*1024*1024)
#define MAX_CLIENTS 4
#define MAX_REPLY_LENGTH (16*1024*1024)


// ---------------------------------------------------------------------------
// small JSON writer
// ---------------------------------------------------------------------------

class json_t
{
	cbuffer_t buf;
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
				buf.append(",");
			}
			first.back() = false;
		}
	}

	void append_string(const char *s)
	{
		buf.append("\"");
		for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
			switch (*p) {
				case '"':  buf.append("\\\""); break;
				case '\\': buf.append("\\\\"); break;
				case '\n': buf.append("\\n"); break;
				case '\r': buf.append("\\r"); break;
				case '\t': buf.append("\\t"); break;
				default:
					if (*p < 0x20) {
						buf.printf("\\u%04x", *p);
					}
					else {
						char c[2] = { (char)*p, 0 };
						buf.append(c);
					}
			}
		}
		buf.append("\"");
	}

public:
	json_t &obj()     { sep(); buf.append("{"); first.push_back(true); return *this; }
	json_t &end_obj() { buf.append("}"); first.pop_back(); return *this; }
	json_t &arr()     { sep(); buf.append("["); first.push_back(true); return *this; }
	json_t &end_arr() { buf.append("]"); first.pop_back(); return *this; }

	json_t &key(const char *k) { sep(); append_string(k); buf.append(":"); after_key = true; return *this; }

	json_t &str(const char *s)
	{
		sep();
		if (s) {
			append_string(s);
		}
		else {
			buf.append("null");
		}
		return *this;
	}
	json_t &num(sint64 v)  { sep(); buf.printf("%lld", (long long)v); return *this; }
	json_t &dbl(double v)
	{
		sep();
		if (std::isfinite(v)) {
			buf.printf("%.15g", v);
		}
		else {
			buf.append("null");
		}
		return *this;
	}
	json_t &boolean(bool b) { sep(); buf.append(b ? "true" : "false"); return *this; }
	json_t &null()          { sep(); buf.append("null"); return *this; }

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

	size_t size() const { return buf.len(); }
	const char *get() const { return buf; }
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


/// tile position from x,y[,z]; if z is missing the ground height is used
static const char *get_tile_pos(const args_t &a, koord3d &pos)
{
	karte_t *welt = world();
	if (!has_arg(a, "x") || !has_arg(a, "y")) {
		return "missing tile coordinates x,y";
	}
	const koord k((sint16)arg_int(a, "x", 0), (sint16)arg_int(a, "y", 0));
	if (!welt->is_within_limits(k)) {
		return "tile coordinates outside of the map";
	}
	if (has_arg(a, "z")) {
		pos = koord3d(k, (sint8)arg_int(a, "z", 0));
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
	// queued string events keep a pointer, so the strings must outlive the event queue
	static std::string text_ring[32];
	static int text_ring_pos = 0;

	const std::string text = arg_str(a, "text");
	if (text.empty()) {
		return "missing text";
	}
	std::string &slot = text_ring[text_ring_pos];
	text_ring_pos = (text_ring_pos + 1) % 32;
	slot = text;

	event_t *ev = new event_t(EVENT_STRING);
	ev->ev_ptr = (void *)slot.c_str();
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


static const char *cmd_messages(const args_t &a, json_t &j)
{
	const int count = (int)clamp<sint64>(arg_int(a, "count", 20), 1, 500);
	int n = 0;
	j.key("messages").arr();
	for (message_node_t *node : world()->get_message()->get_list()) {
		if (n++ >= count) {
			break;
		}
		j.obj();
		j.kv("text", node->msg);
		j.kv("type", (int)(node->type & message_t::MESSAGE_TYPE_MASK));
		write_date(j, "date", (uint32)node->time);
		write_koord3d(j, "pos", node->pos);
		j.end_obj();
	}
	j.end_arr();
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


static void write_factory_brief(json_t &j, fabrik_t *fab, bool details)
{
	j.obj();
	j.kv("name", translator::translate(fab->get_name()));
	j.kv("type", fab->get_desc()->get_name());
	write_koord3d(j, "pos", fab->get_pos());
	if (details) {
		j.kv("production", (sint64)fab->get_current_production());
		const factory_desc_t *desc = fab->get_desc();
		for (int io = 0; io < 2; io++) {
			const array_tpl<ware_production_t> &slots = io == 0 ? fab->get_input() : fab->get_output();
			j.key(io == 0 ? "inputs" : "outputs").arr();
			for (uint32 i = 0; i < slots.get_count(); i++) {
				ware_production_t const &w = slots[i];
				// the factory window scales the storage with the consumption/production factor (fabrik_t::info_prod)
				sint64 factor = DEFAULT_PRODUCTION_FACTOR;
				if (io == 0  &&  desc->get_supplier(i)) {
					factor = desc->get_supplier(i)->get_consumption();
				}
				else if (io == 1  &&  desc->get_product(i)) {
					factor = desc->get_product(i)->get_factor();
				}
				const char *unit = w.get_typ() ? translator::translate(w.get_typ()->get_mass()) : "";
				while (*unit == ' ') {
					unit++;
				}
				j.obj();
				j.kv("goods", w.get_typ() ? translator::translate(w.get_typ()->get_name()) : "?");
				j.kv("unit", unit);
				j.kv("storage", convert_goods((sint64)w.menge * factor));
				j.kv("max", convert_goods((sint64)w.max * factor));
				if (io == 0) {
					j.kv("in_transit", (sint64)w.get_in_transit());
					write_goods_stat(j, "received", w, FAB_GOODS_RECEIVED);
					write_goods_stat(j, "consumed", w, FAB_GOODS_CONSUMED);
				}
				else {
					write_goods_stat(j, "produced", w, FAB_GOODS_PRODUCED);
					write_goods_stat(j, "delivered", w, FAB_GOODS_DELIVERED);
				}
				j.end_obj();
			}
			j.end_arr();
		}
		j.kv("suppliers", (uint32)fab->get_suppliers().get_count());
		j.kv("consumers", (uint32)fab->get_consumer().get_count());
	}
	j.end_obj();
}


static const char *convoy_state_name(int state)
{
	static const char *const names[] = {
		"in_depot", "edit_schedule", "routing", "dummy4", "dummy5", "no_route", "driving", "loading",
		"waiting_for_clearance", "waiting_for_clearance_one_month", "can_start", "can_start_one_month",
		"self_destruct", "waiting_for_clearance_two_months", "can_start_two_months", "leaving_depot", "entering_depot"
	};
	return state >= 0 && state < (int)(sizeof(names) / sizeof(names[0])) ? names[state] : "unknown";
}


static void write_convoy(json_t &j, convoihandle_t cnv, bool details)
{
	j.obj();
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

	std::vector<std::string> terrain, height, owner, slope;
	sint8 zmin = 127;
	for (sint16 y = lo.y; y < lo.y + size.y; y++) {
		for (sint16 x = lo.x; x < lo.x + size.x; x++) {
			const sint8 z = welt->lookup_kartenboden(x, y)->get_pos().z;
			if (z < zmin) {
				zmin = z;
			}
		}
	}
	static const char height_digits[] = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

	vector_tpl<halthandle_t> halts;
	vector_tpl<fabrik_t *> factories;
	vector_tpl<convoihandle_t> convoys;

	j.key("height_base").num(zmin);
	for (sint16 y = lo.y; y < lo.y + size.y; y++) {
		std::string t_row, h_row, o_row, s_row;
		for (sint16 x = lo.x; x < lo.x + size.x; x++) {
			const planquadrat_t *plan = welt->access(x, y);
			const grund_t *gr = plan->get_kartenboden();
			sint8 own;
			t_row += tile_char(plan, own);
			o_row += owner_char(own);
			h_row += height_digits[clamp(gr->get_pos().z - zmin, 0, 61)];
			s_row += slope_char(gr->get_grund_hang());

			if (want_features) {
				for (unsigned i = 0; i < plan->get_boden_count(); i++) {
					const grund_t *g = plan->get_boden_bei(i);
					if (g->is_halt()) {
						const halthandle_t halt = g->get_halt();
						if (halt.is_bound()) {
							halts.append_unique(halt);
						}
					}
					for (uint8 n = 0; n < g->obj_count(); n++) {
						obj_t *obj = g->obj_bei(n);
						if (obj->get_typ() == obj_t::gebaeude) {
							if (fabrik_t *fab = static_cast<gebaeude_t *>(obj)->get_fabrik()) {
								factories.append_unique(fab);
							}
						}
						else if (obj->is_moving()) {
							if (vehicle_t *v = dynamic_cast<vehicle_t *>(obj)) {
								if (v->get_convoi()) {
									convoys.append_unique(v->get_convoi()->self);
								}
							}
						}
					}
				}
			}
		}
		terrain.push_back(t_row);
		height.push_back(h_row);
		owner.push_back(o_row);
		slope.push_back(s_row);
	}

	const std::vector<std::string> *rows[4] = { &terrain, &height, &owner, &slope };
	const char *row_names[4] = { "terrain", "height", "owner", "slope" };
	const bool wanted[4] = { want_terrain, want_height, want_owner, want_slope };
	for (int l = 0; l < 4; l++) {
		if (!wanted[l]) {
			continue;
		}
		j.key(row_names[l]).arr();
		for (std::string const &r : *rows[l]) {
			j.str(r.c_str());
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

		// labels (map markers) and depots
		j.key("labels").arr();
		for (sint16 y = lo.y; y < hi.y; y++) {
			for (sint16 x = lo.x; x < hi.x; x++) {
				const grund_t *gr = welt->lookup_kartenboden(x, y);
				if (gr->find<label_t>()) {
					j.obj();
					write_koord3d(j, "pos", gr->get_pos());
					j.kv("text", gr->get_text());
					j.end_obj();
				}
			}
		}
		j.end_arr();
		j.key("depots").arr();
		for (sint16 y = lo.y; y < hi.y; y++) {
			for (sint16 x = lo.x; x < hi.x; x++) {
				const grund_t *gr = welt->lookup_kartenboden(x, y);
				if (const depot_t *dep = gr->get_depot()) {
					j.obj();
					write_koord3d(j, "pos", gr->get_pos());
					j.kv("type", obj_type_name(dep->get_typ()));
					j.kv("owner", owner_of(dep->get_owner_nr()));
					j.end_obj();
				}
			}
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
		finance_t *f = player->get_finance();
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


static const char *cmd_cities(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	vector_tpl<stadt_t *> cities;
	for (stadt_t *city : welt->get_cities()) {
		cities.append(city);
	}
	std::sort(cities.begin(), cities.end(), [](const stadt_t *a, const stadt_t *b) { return a->get_einwohner() > b->get_einwohner(); });
	const sint64 limit = arg_int(a, "limit", 100);
	j.kv("count", (uint32)cities.get_count());
	j.key("cities").arr();
	sint64 n = 0;
	for (stadt_t *city : cities) {
		if (n++ >= limit) {
			break;
		}
		j.obj();
		j.kv("name", city->get_name());
		write_pos2(j, "townhall", city->get_pos());
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
		j.end_obj();
	}
	j.end_arr();
	return NULL;
}


static const char *cmd_stations(const args_t &a, json_t &j)
{
	const sint64 limit = arg_int(a, "limit", 200);
	sint64 n = 0;
	j.key("stations").arr();
	for (halthandle_t halt : haltestelle_t::get_alle_haltestellen()) {
		if (!halt.is_bound()) {
			continue;
		}
		const int owner = halt->get_first_owner() ? halt->get_first_owner()->get_player_nr() : -1;
		if (!owner_matches(a, owner)) {
			continue;
		}
		if (n++ >= limit) {
			break;
		}
		write_halt_brief(j, halt);
	}
	j.end_arr();
	j.kv("truncated", n > limit);
	return NULL;
}


static const char *cmd_station(const args_t &a, json_t &j)
{
	halthandle_t halt;
	if (has_arg(a, "id")) {
		halt.set_id((uint16)arg_int(a, "id", 0));
	}
	else if (has_arg(a, "x") && has_arg(a, "y")) {
		halt = haltestelle_t::get_halt_koord_index(koord((sint16)arg_int(a, "x", 0), (sint16)arg_int(a, "y", 0)));
	}
	if (!halt.is_bound()) {
		return "no station with this id / at this position";
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
	return NULL;
}


static const char *cmd_convoys(const args_t &a, json_t &j)
{
	const sint64 limit = arg_int(a, "limit", 200);
	sint64 n = 0;
	j.key("convoys").arr();
	for (convoihandle_t cnv : world()->convoys()) {
		if (!cnv.is_bound()) {
			continue;
		}
		const int owner = cnv->get_owner() ? cnv->get_owner()->get_player_nr() : -1;
		if (!owner_matches(a, owner)) {
			continue;
		}
		if (n++ >= limit) {
			break;
		}
		write_convoy(j, cnv, true);
	}
	j.end_arr();
	j.kv("truncated", n > limit);
	return NULL;
}


static const char *cmd_lines(const args_t &a, json_t &j)
{
	karte_t *welt = world();
	const sint64 limit = arg_int(a, "limit", 200);
	sint64 n = 0;
	j.key("lines").arr();
	for (int i = 0; i < MAX_PLAYER_COUNT && n <= limit; i++) {
		player_t *player = welt->get_player(i);
		if (player == NULL || !owner_matches(a, i)) {
			continue;
		}
		for (linehandle_t line : player->simlinemgmt.get_line_list()) {
			if (!line.is_bound()) {
				continue;
			}
			if (n++ >= limit) {
				break;
			}
			j.obj();
			j.kv("id", (int)line.get_id());
			j.kv("name", line->get_name());
			j.kv("owner", i);
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
			for (int m = 0; m < 2; m++) {
				j.key(m == 0 ? "this_month" : "last_month").obj();
				j.kv("profit", money(line->get_finance_history(m, LINE_PROFIT)));
				j.kv("revenue", money(line->get_finance_history(m, LINE_REVENUE)));
				j.kv("transported", (sint64)line->get_finance_history(m, LINE_TRANSPORTED_GOODS));
				j.kv("capacity", (sint64)line->get_finance_history(m, LINE_CAPACITY));
				j.end_obj();
			}
			j.end_obj();
		}
	}
	j.end_arr();
	j.kv("truncated", n > limit);
	return NULL;
}


static const char *cmd_factories(const args_t &a, json_t &j)
{
	const sint64 limit = arg_int(a, "limit", 200);
	const bool region = has_arg(a, "x1") && has_arg(a, "y1") && has_arg(a, "x2") && has_arg(a, "y2");
	const sint64 x1 = arg_int(a, "x1", 0), y1 = arg_int(a, "y1", 0), x2 = arg_int(a, "x2", 0), y2 = arg_int(a, "y2", 0);
	sint64 n = 0;
	j.kv("count", (uint32)world()->get_fab_list().get_count());
	j.key("factories").arr();
	for (fabrik_t *fab : world()->get_fab_list()) {
		const koord3d p = fab->get_pos();
		if (region && (p.x < x1 || p.x > x2 || p.y < y1 || p.y > y2)) {
			continue;
		}
		if (n++ >= limit) {
			break;
		}
		write_factory_brief(j, fab, true);
	}
	j.end_arr();
	j.kv("truncated", n > limit);
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


struct command_t
{
	const char *name;
	command_fn fn;
};

static const command_t commands[] = {
	{ "ping",         cmd_ping },
	{ "status",       cmd_status },
	{ "windows",      cmd_windows },
	{ "click",        cmd_click },
	{ "move",         cmd_move },
	{ "drag",         cmd_drag },
	{ "wheel",        cmd_wheel },
	{ "key",          cmd_key },
	{ "text",         cmd_text },
	{ "screenshot",   cmd_screenshot },
	{ "view",         cmd_view },
	{ "tile_at",      cmd_tile_at },
	{ "screen_pos",   cmd_screen_pos },
	{ "tile",         cmd_tile },
	{ "messages",     cmd_messages },
	{ "pause",        cmd_pause },
	{ "fast_forward", cmd_fast_forward },
	{ "zoom",         cmd_zoom },
	{ "eval",         cmd_eval },
	{ "map",          cmd_map },
	{ "players",      cmd_players },
	{ "cash",         cmd_cash },
	{ "cities",       cmd_cities },
	{ "stations",     cmd_stations },
	{ "station",      cmd_station },
	{ "convoys",      cmd_convoys },
	{ "lines",        cmd_lines },
	{ "factories",    cmd_factories },
	{ "toolbars",     cmd_toolbars },
	{ "tool_visibility", cmd_tool_visibility },
	{ "unlock_game",  cmd_unlock_game },
};


static std::string execute_request(const std::string &line)
{
	const size_t space = line.find(' ');
	const std::string name = line.substr(0, space);
	args_t args;
	if (space != std::string::npos) {
		parse_args(line.substr(space + 1), args);
	}

	json_t j;
	j.obj();
	const char *err = "unknown command";
	if (world() == NULL) {
		err = "no world loaded";
	}
	else {
		for (command_t const &cmd : commands) {
			if (name == cmd.name) {
				err = cmd.fn(args, j);
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
	return std::string(j.get()) + "\n";
}


// ---------------------------------------------------------------------------
// sockets
// ---------------------------------------------------------------------------

struct remote_client_t
{
	SOCKET sock;
	std::string inbuf;
	bool greeted;
};

static SOCKET listen_socket = INVALID_SOCKET;
static std::vector<remote_client_t> clients;
static bool in_poll = false;


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


/// sends all data, waits up to 10s for a slow client
static bool send_all(SOCKET s, const std::string &data)
{
	size_t sent = 0;
	const uint32 start = dr_time();
	while (sent < data.size()) {
#ifdef MSG_NOSIGNAL
		const int flags = MSG_NOSIGNAL;
#else
		const int flags = 0;
#endif
		const size_t remaining = data.size() - sent;
		const int chunk = (int)(remaining < 65536 ? remaining : 65536);
		const int n = (int)send(s, data.c_str() + sent, chunk, flags);
		if (n > 0) {
			sent += n;
			continue;
		}
		if (n < 0 && would_block() && dr_time() - start < 10000) {
			fd_set fds;
			FD_ZERO(&fds);
			FD_SET(s, &fds);
			timeval tv = { 0, 50000 };
			select((int)s + 1, NULL, &fds, NULL, &tv);
			continue;
		}
		return false;
	}
	return true;
}


bool remote_control_init(int port)
{
	if (listen_socket != INVALID_SOCKET) {
		return true;
	}
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

	if (bind(listen_socket, (sockaddr *)&addr, sizeof(addr)) != 0 || listen(listen_socket, 4) != 0 || !set_nonblocking(listen_socket, true)) {
		dbg->error("remote_control_init", "could not listen on 127.0.0.1:%d (error %d)", port, GET_LAST_ERROR());
		network_close_socket(listen_socket);
		listen_socket = INVALID_SOCKET;
		return false;
	}
	dbg->message("remote_control_init", "remote control listening on 127.0.0.1:%d", port);
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
	if (listen_socket != INVALID_SOCKET) {
		network_close_socket(listen_socket);
		listen_socket = INVALID_SOCKET;
	}
	reset_eval_vm();
}


/// handles all complete lines of a client, returns false if the connection must be closed
static bool process_client(remote_client_t &c)
{
	size_t nl;
	while ((nl = c.inbuf.find('\n')) != std::string::npos) {
		std::string line = c.inbuf.substr(0, nl);
		c.inbuf.erase(0, nl + 1);
		if (!line.empty() && line[line.size() - 1] == '\r') {
			line.erase(line.size() - 1);
		}
		if (!c.greeted) {
			// protects against anything else talking to this port, e.g. web pages sending HTTP requests
			if (line != REMOTE_HELLO) {
				dbg->warning("remote_control", "closing connection with wrong greeting");
				return false;
			}
			c.greeted = true;
			json_t j;
			j.obj().kv("ok", true).kv("protocol", REMOTE_PROTOCOL_VERSION).end_obj();
			if (!send_all(c.sock, std::string(j.get()) + "\n")) {
				return false;
			}
			continue;
		}
		if (line.empty()) {
			continue;
		}
		if (!send_all(c.sock, execute_request(line))) {
			return false;
		}
	}
	return c.inbuf.size() <= MAX_REQUEST_LENGTH;
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
		remote_client_t c;
		c.sock = s;
		c.greeted = false;
		clients.push_back(c);
	}

	// read requests
	for (size_t i = 0; i < clients.size(); ) {
		remote_client_t &c = clients[i];
		bool keep = true;
		char buf[16384];
		while (true) {
			const int n = (int)recv(c.sock, buf, sizeof(buf), 0);
			if (n > 0) {
				c.inbuf.append(buf, n);
				if (c.inbuf.size() > MAX_REQUEST_LENGTH + 2) {
					break;
				}
				continue;
			}
			if (n == 0 || !would_block()) {
				keep = false; // closed or error
			}
			break;
		}
		if (keep) {
			keep = process_client(c);
		}
		if (!keep) {
			network_close_socket(c.sock);
			clients.erase(clients.begin() + i);
		}
		else {
			i++;
		}
	}
	in_poll = false;
}
