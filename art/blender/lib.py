"""Scene, camera, light, material and mesh helpers for rendering game sprites in Blender.

The camera reproduces the game's 2:1 isometric projection (see src/render/iso.ts): tile x+1 moves
32 px right and 16 px down, tile y+1 moves 32 px left and 16 px down. World X is tile x, world Y is
minus tile y, world Z is up; one world unit is one tile. Sprites are rendered at the atlas
resolution (2× the game's logical pixels).
"""

import math

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

RESOLUTION = 2
#: Logical pixels per world unit along the screen x axis: one tile step is 32 px right = cos 45° units.
PX_PER_UNIT = 32 / math.cos(math.radians(45))
CAM_TILT = math.radians(60)  # 30° elevation gives the 2:1 ratio
CAM_YAW = math.radians(45)


def reset_scene(samples=48):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = 'GPU'
    except Exception:
        scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 4
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.0
    scene.render.filter_size = 1.2

    world = bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.66, 0.85, 1)
    bg.inputs['Strength'].default_value = 0.42

    # Sun from the screen's upper left, like the procedural art's lighting.
    sun_data = bpy.data.lights.new('Sun', 'SUN')
    sun_data.energy = 3.3
    sun_data.angle = math.radians(4)
    sun_data.color = (1.0, 0.96, 0.88)
    sun = bpy.data.objects.new('Sun', sun_data)
    scene.collection.objects.link(sun)
    toward = Vector((0.95, -0.32, -1.7)).normalized()  # travels from the screen's upper left
    sun.rotation_euler = toward.to_track_quat('-Z', 'Y').to_euler()

    # Ground that only receives shadows (stays transparent).
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.name = 'ShadowCatcher'
    ground.is_shadow_catcher = True
    return scene


def setup_camera(scene, w, h, ax, ay, target=(0.0, 0.0, 0.0)):
    """Orthographic camera so that `target` lands at logical pixel (ax, ay) of a w×h sprite."""
    cam_data = bpy.data.cameras.new('Camera')
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.new('Camera', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_euler = (CAM_TILT, 0, CAM_YAW)
    back = Vector((math.sin(CAM_YAW) * math.sin(CAM_TILT), -math.cos(CAM_YAW) * math.sin(CAM_TILT), math.cos(CAM_TILT)))
    cam.location = Vector(target) + back * 40
    cam_data.clip_start = 1
    cam_data.clip_end = 100
    big = max(w, h)
    cam_data.ortho_scale = big / PX_PER_UNIT
    cam_data.shift_x = -(ax - w / 2) / big
    cam_data.shift_y = (ay - h / 2) / big
    scene.render.resolution_x = w * RESOLUTION
    scene.render.resolution_y = h * RESOLUTION
    scene.render.resolution_percentage = 100
    return cam


def screen_point(scene, point):
    """Logical sprite pixel (x, y) of a world point (for anchoring things drawn by the game)."""
    co = world_to_camera_view(scene, scene.camera, Vector(point))
    return (co.x * scene.render.resolution_x / RESOLUTION, (1 - co.y) * scene.render.resolution_y / RESOLUTION)


def camera_depth(scene, point):
    """Distance of a world point from the camera plane (larger = further away)."""
    return world_to_camera_view(scene, scene.camera, Vector(point)).z


def ground_dir(screen_angle):
    """World ground direction (x, y) that the camera shows at a screen angle (radians, y down)."""
    c, s = math.cos(screen_angle), math.sin(screen_angle)
    gx = c / math.sqrt(2) + s * math.sqrt(2)
    gy = c / math.sqrt(2) - s * math.sqrt(2)
    n = math.hypot(gx, gy)
    return gx / n, gy / n


def apply_ao(strength=0.75, distance=0.12):
    """Darkens creases and contacts in every material (base colour × ambient occlusion), the dark
    crevices that give Settlers 4 sprites their depth. Idempotent."""
    for mat in bpy.data.materials:
        if not mat.use_nodes or mat.get('ao'):
            continue
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = nodes.get('Principled BSDF')
        if bsdf is None:
            continue
        sock = bsdf.inputs['Base Color']
        ao = nodes.new('ShaderNodeAmbientOcclusion')
        ao.inputs['Distance'].default_value = distance
        ao.samples = 8
        fac = nodes.new('ShaderNodeMapRange')
        fac.inputs['To Min'].default_value = 1 - strength
        links.new(ao.outputs['AO'], fac.inputs['Value'])
        mul = nodes.new('ShaderNodeMix')
        mul.data_type = 'RGBA'
        mul.blend_type = 'MULTIPLY'
        mul.inputs['Factor'].default_value = 1.0
        if sock.links:
            links.new(sock.links[0].from_socket, mul.inputs['A'])
        else:
            mul.inputs['A'].default_value = sock.default_value
        links.new(fac.outputs['Result'], mul.inputs['B'])
        links.new(mul.outputs['Result'], sock)
        mat['ao'] = True


def tag(stage, until=None, split=None):
    """Marks every object not yet tagged as appearing at construction `stage` (and, with `until`,
    disappearing after it). `split(obj)` may return the stage per object instead."""
    for obj in bpy.context.scene.objects:
        if obj.type not in ('MESH',) or 'stage' in obj:
            continue
        obj['stage'] = split(obj) if split else stage
        obj['until'] = 99 if until is None else until


def show_stage(k):
    """Shows what stands at construction stage `k` (untagged objects always)."""
    for obj in bpy.context.scene.objects:
        if 'stage' in obj:
            obj.hide_render = not (obj['stage'] <= k <= obj['until'])


def render_to(scene, path):
    apply_ao()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    clean_alpha(path)


#: Post-processing towards the Settlers 4 look: punchy colour, firm contrast, crisp detail.
SATURATION = 1.2
CONTRAST = 1.15
SHARPEN = 0.6


def clean_alpha(path, floor=0.05):
    """Finishes a render: drops the faint veil the shadow catcher leaves over the frame (alpha below
    `floor`), then boosts saturation and contrast and sharpens (unsharp mask) the colour."""
    import numpy as np

    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    rgba = px.reshape(h, w, 4)
    rgba[rgba[..., 3] < floor] = 0
    a = rgba[..., 3:4]
    # Work on straight (unpremultiplied) colour where there is coverage.
    rgb = np.where(a > 0, rgba[..., :3], 0.0)
    grey = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    rgb = grey[..., None] + (rgb - grey[..., None]) * SATURATION
    rgb = (rgb - 0.5) * CONTRAST + 0.5
    blur = rgb.copy()
    blur[1:-1, 1:-1] = (
        rgb[:-2, 1:-1] + rgb[2:, 1:-1] + rgb[1:-1, :-2] + rgb[1:-1, 2:] + 4 * rgb[1:-1, 1:-1]
    ) / 8
    rgb = rgb + (rgb - blur) * SHARPEN
    rgba[..., :3] = np.clip(np.where(a > 0, rgb, 0.0), 0, 1)
    img.pixels.foreach_set(rgba.ravel())
    img.save()
    bpy.data.images.remove(img)


# ---------------------------------------------------------------------------------------- materials

def lin(c):
    """Palette colours are written as on screen (sRGB); Blender wants linear values."""
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


def _principled(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes['Principled BSDF']
    return mat, nodes, mat.node_tree.links, bsdf


def mat_flat(name, color, rough=0.75):
    mat, _, _, bsdf = _principled(name)
    bsdf.inputs['Base Color'].default_value = (*lin(color), 1)
    bsdf.inputs['Roughness'].default_value = rough
    return mat


def mat_noisy(name, a, b, scale=6.0, rough=0.8, detail=4.0, stretch=None):
    """Two colours mixed by noise: wood, foliage, earth, rock."""
    mat, nodes, links, bsdf = _principled(name)
    bsdf.inputs['Roughness'].default_value = rough
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = detail
    if stretch:
        coord = nodes.new('ShaderNodeTexCoord')
        mapping = nodes.new('ShaderNodeMapping')
        mapping.inputs['Scale'].default_value = stretch
        links.new(coord.outputs['Object'], mapping.inputs['Vector'])
        links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (*lin(a), 1)
    ramp.color_ramp.elements[1].position = 0.65
    ramp.color_ramp.elements[1].color = (*lin(b), 1)
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def mat_brick(name, c1, c2, mortar, scale=8.0, row=0.25, width=0.5, mortar_size=0.02, rough=0.85, roof=None):
    """Brick pattern: stone walls (rows by height, running round the corners) or roof tiles (`roof`
    names the ridge axis, 'x' or 'y': columns along the ridge, rows by height)."""
    mat, nodes, links, bsdf = _principled(name)
    bsdf.inputs['Roughness'].default_value = rough
    coord = nodes.new('ShaderNodeTexCoord')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Object'], sep.inputs['Vector'])
    comb = nodes.new('ShaderNodeCombineXYZ')
    if roof:
        links.new(sep.outputs[roof.upper()], comb.inputs['X'])
    else:
        add = nodes.new('ShaderNodeMath')
        add.operation = 'ADD'
        links.new(sep.outputs['X'], add.inputs[0])
        links.new(sep.outputs['Y'], add.inputs[1])
        links.new(add.outputs['Value'], comb.inputs['X'])
    links.new(sep.outputs['Z'], comb.inputs['Y'])
    brick = nodes.new('ShaderNodeTexBrick')
    brick.inputs['Color1'].default_value = (*lin(c1), 1)
    brick.inputs['Color2'].default_value = (*lin(c2), 1)
    brick.inputs['Mortar'].default_value = (*lin(mortar), 1)
    brick.inputs['Scale'].default_value = scale
    brick.inputs['Mortar Size'].default_value = mortar_size
    brick.inputs['Brick Width'].default_value = width
    brick.inputs['Row Height'].default_value = row
    brick.offset = 0.5
    links.new(comb.outputs['Vector'], brick.inputs['Vector'])
    links.new(brick.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def _bump(nodes, links, bsdf, height_socket, strength=0.4, distance=0.02):
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = strength
    bump.inputs['Distance'].default_value = distance
    links.new(height_socket, bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])


def _ramp(nodes, stops):
    ramp = nodes.new('ShaderNodeValToRGB')
    els = ramp.color_ramp.elements
    while len(els) < len(stops):
        els.new(0.5)
    for el, (pos, col) in zip(els, stops):
        el.position = pos
        el.color = (*lin(col), 1)
    return ramp


def mat_stones(name, light, dark, mortar, scale=9.0, bump=0.6):
    """Irregular fieldstone masonry: Voronoi cells with colour variation and dark mortar joints."""
    mat, nodes, links, bsdf = _principled(name)
    bsdf.inputs['Roughness'].default_value = 0.9
    coord = nodes.new('ShaderNodeTexCoord')
    vor = nodes.new('ShaderNodeTexVoronoi')
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs['Scale'].default_value = scale
    links.new(coord.outputs['Object'], vor.inputs['Vector'])
    cells = nodes.new('ShaderNodeTexVoronoi')
    cells.inputs['Scale'].default_value = scale
    links.new(coord.outputs['Object'], cells.inputs['Vector'])
    stone = _ramp(nodes, [(0.0, dark), (1.0, light)])
    links.new(cells.outputs['Color'], stone.inputs['Fac'])  # Color output drives a per-stone value
    joint = nodes.new('ShaderNodeMapRange')
    joint.inputs['From Min'].default_value = 0.02
    joint.inputs['From Max'].default_value = 0.08
    links.new(vor.outputs['Distance'], joint.inputs['Value'])
    mix = nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs['A'].default_value = (*lin(mortar), 1)
    links.new(joint.outputs['Result'], mix.inputs['Factor'])
    links.new(stone.outputs['Color'], mix.inputs['B'])
    grime = nodes.new('ShaderNodeTexNoise')
    grime.inputs['Scale'].default_value = scale * 3
    grime.inputs['Detail'].default_value = 8
    links.new(coord.outputs['Object'], grime.inputs['Vector'])
    dirt = nodes.new('ShaderNodeMix')
    dirt.data_type = 'RGBA'
    dirt.blend_type = 'MULTIPLY'
    dirt.inputs['Factor'].default_value = 0.35
    links.new(mix.outputs['Result'], dirt.inputs['A'])
    links.new(grime.outputs['Color'], dirt.inputs['B'])
    links.new(dirt.outputs['Result'], bsdf.inputs['Base Color'])
    _bump(nodes, links, bsdf, joint.outputs['Result'], strength=bump)
    return mat


def mat_tiles(name, c1, c2, mortar, scale=7.0, along='y'):
    """Weathered terracotta roof tiles: offset rows (by height), per-tile colour, ridged bump."""
    mat, nodes, links, bsdf = _principled(name)
    bsdf.inputs['Roughness'].default_value = 0.8
    coord = nodes.new('ShaderNodeTexCoord')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Object'], sep.inputs['Vector'])
    comb = nodes.new('ShaderNodeCombineXYZ')
    links.new(sep.outputs[along.upper()], comb.inputs['X'])
    links.new(sep.outputs['Z'], comb.inputs['Y'])
    brick = nodes.new('ShaderNodeTexBrick')
    brick.inputs['Color1'].default_value = (*lin(c1), 1)
    brick.inputs['Color2'].default_value = (*lin(c2), 1)
    brick.inputs['Mortar'].default_value = (*lin(mortar), 1)
    brick.inputs['Scale'].default_value = scale
    brick.inputs['Mortar Size'].default_value = 0.03
    brick.inputs['Bias'].default_value = 0.0
    brick.inputs['Brick Width'].default_value = 0.42
    brick.inputs['Row Height'].default_value = 0.2
    brick.offset = 0.5
    links.new(comb.outputs['Vector'], brick.inputs['Vector'])
    grime = nodes.new('ShaderNodeTexNoise')
    grime.inputs['Scale'].default_value = 14
    grime.inputs['Detail'].default_value = 8
    links.new(coord.outputs['Object'], grime.inputs['Vector'])
    dirt = nodes.new('ShaderNodeMix')
    dirt.data_type = 'RGBA'
    dirt.blend_type = 'MULTIPLY'
    dirt.inputs['Factor'].default_value = 0.45
    links.new(brick.outputs['Color'], dirt.inputs['A'])
    links.new(grime.outputs['Color'], dirt.inputs['B'])
    links.new(dirt.outputs['Result'], bsdf.inputs['Base Color'])
    # Each tile bulges: a wave across the tile plus the joints.
    wave = nodes.new('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = scale * 1.2
    wave.bands_direction = 'X'
    links.new(comb.outputs['Vector'], wave.inputs['Vector'])
    add = nodes.new('ShaderNodeMath')
    links.new(wave.outputs['Fac'], add.inputs[0])
    links.new(brick.outputs['Fac'], add.inputs[1])
    _bump(nodes, links, bsdf, add.outputs['Value'], strength=0.7)
    return mat


def mat_grain(name, a, b, scale=5.0, stretch=(1, 1, 10), bump=0.5, detail=8.0):
    """Wood, thatch, bark: stretched noise colour with matching bump."""
    mat, nodes, links, bsdf = _principled(name)
    bsdf.inputs['Roughness'].default_value = 0.85
    coord = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = stretch
    links.new(coord.outputs['Object'], mapping.inputs['Vector'])
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = detail
    noise.inputs['Roughness'].default_value = 0.65
    links.new(mapping.outputs['Vector'], noise.inputs['Vector'])
    ramp = _ramp(nodes, [(0.3, a), (0.7, b)])
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    _bump(nodes, links, bsdf, noise.outputs['Fac'], strength=bump)
    return mat


def mat_leaves(name, dark, mid, light, scale=14.0):
    """Foliage: speckled dark-to-bright greens with a strong bump, like many small leaves."""
    mat, nodes, links, bsdf = _principled(name)
    bsdf.inputs['Roughness'].default_value = 0.7
    coord = nodes.new('ShaderNodeTexCoord')
    vor = nodes.new('ShaderNodeTexVoronoi')
    vor.inputs['Scale'].default_value = scale
    links.new(coord.outputs['Object'], vor.inputs['Vector'])
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale / 3
    noise.inputs['Detail'].default_value = 6
    links.new(coord.outputs['Object'], noise.inputs['Vector'])
    mixf = nodes.new('ShaderNodeMath')
    mixf.operation = 'MULTIPLY_ADD'
    mixf.inputs[1].default_value = 0.6
    links.new(vor.outputs['Distance'], mixf.inputs[0])
    links.new(noise.outputs['Fac'], mixf.inputs[2])
    ramp = _ramp(nodes, [(0.35, dark), (0.6, mid), (0.85, light)])
    links.new(mixf.outputs['Value'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    _bump(nodes, links, bsdf, vor.outputs['Distance'], strength=0.9, distance=0.05)
    return mat


# -------------------------------------------------------------------------------------------- meshes

def _finish(obj, mat, bevel=0.0, smooth=False):
    if mat is not None:
        obj.data.materials.append(mat)
    if bevel > 0:
        mod = obj.modifiers.new('Bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
    if smooth:
        bpy.ops.object.shade_smooth()
    return obj


def pad(loc, hx, hy, mat, verts=96, jitter=0.12, seed=1, thickness=0.012, power=4.0):
    """A flat, ragged, squarish patch on the ground (half sizes `hx`, `hy`): the trodden earth around
    buildings. A superellipse with a jittered edge."""
    import random

    rnd = random.Random(seed)
    cx, cy, cz = loc
    # A smooth wobble (a few low-frequency waves), not per-vertex noise.
    waves = [(rnd.randint(2, 7), rnd.uniform(0, math.tau), rnd.uniform(0.3, 1.0)) for _ in range(4)]
    norm = sum(w[2] for w in waves)
    pts = []
    for i in range(verts):
        a = i / verts * math.tau
        c, s_ = math.cos(a), math.sin(a)
        k = 1 + jitter * sum(amp * math.sin(f * a + ph) for f, ph, amp in waves) / norm
        x = math.copysign(abs(c) ** (2 / power), c) * hx * k
        y = math.copysign(abs(s_) ** (2 / power), s_) * hy * k
        pts.append((cx + x, cy + y, cz))
    mesh = bpy.data.meshes.new('pad')
    mesh.from_pydata([(cx, cy, cz)] + pts, [], [(0, i + 1, (i + 1) % verts + 1) for i in range(verts)])
    obj = bpy.data.objects.new('pad', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    mod = obj.modifiers.new('Solid', 'SOLIDIFY')
    mod.thickness = thickness
    mod.offset = 1
    return obj


def box(loc, size, mat, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(obj, mat, bevel)


def cylinder(loc, radius, depth, mat, rot=(0, 0, 0), verts=16, radius2=None, bevel=0.0):
    if radius2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=radius, radius2=radius2, depth=depth, location=loc, rotation=rot)
    obj = bpy.context.active_object
    return _finish(obj, mat, bevel, smooth=True)


def sphere(loc, radius, mat, scale=(1, 1, 1), subdiv=3):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=radius, location=loc)
    obj = bpy.context.active_object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(obj, mat, smooth=True)


def lumpy(loc, radius, mat, scale=(1, 1, 1), strength=0.25, noise=1.6, seed=0, subdiv=3, flat=False):
    """A displaced sphere: foliage clumps, rocks (`flat`: faceted)."""
    obj = sphere(loc, radius, mat, scale, subdiv)
    if flat:
        bpy.ops.object.shade_flat()
    tex = bpy.data.textures.new(f'lump{seed}', 'CLOUDS')
    tex.noise_scale = radius * noise
    mod = obj.modifiers.new('Displace', 'DISPLACE')
    mod.texture = tex
    mod.strength = radius * strength
    mod.mid_level = 0.5
    obj.modifiers['Displace'].texture_coords = 'GLOBAL'
    return obj


def prism_roof(center, length, width, height, mat, overhang=0.12, thickness=0.06, along='x'):
    """Gable roof with the ridge along world X (or Y): ridge at `center` z + height, `length` along
    the ridge, `width` across it, eaves overhanging the walls."""
    cx, cy, cz = center
    drop = overhang * height / (width / 2)
    x0, x1 = cx - length / 2 - overhang, cx + length / 2 + overhang
    ye = width / 2 + overhang
    verts = [
        (x0, cy - ye, cz - drop), (x1, cy - ye, cz - drop),
        (x1, cy, cz + height), (x0, cy, cz + height),
        (x0, cy + ye, cz - drop), (x1, cy + ye, cz - drop),
    ]
    if along == 'y':
        verts = [(cx + (y - cy), cy + (x - cx), z) for x, y, z in verts]
    mesh = bpy.data.meshes.new('roof')
    faces = [(0, 1, 2, 3), (3, 2, 5, 4)] if along == 'x' else [(3, 2, 1, 0), (4, 5, 2, 3)]
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new('roof', mesh)
    bpy.context.scene.collection.objects.link(obj)
    mod = obj.modifiers.new('Solid', 'SOLIDIFY')
    mod.thickness = thickness
    obj.data.materials.append(mat)
    return obj


def gable(center, width, height, at, mat, along='x'):
    """Triangular gable wall closing a roof whose ridge runs along `along`, standing at that
    coordinate `at`."""
    cx, cy, cz = center
    mesh = bpy.data.meshes.new('gable')
    if along == 'x':
        verts = [(at, cy - width / 2, cz), (at, cy + width / 2, cz), (at, cy, cz + height)]
    else:
        verts = [(cx - width / 2, at, cz), (cx + width / 2, at, cz), (cx, at, cz + height)]
    mesh.from_pydata(verts, [], [(0, 1, 2)])
    obj = bpy.data.objects.new('gable', mesh)
    bpy.context.scene.collection.objects.link(obj)
    mod = obj.modifiers.new('Solid', 'SOLIDIFY')
    mod.thickness = 0.04
    obj.data.materials.append(mat)
    return obj


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    return obj
