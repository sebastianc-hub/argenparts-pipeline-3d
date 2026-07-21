"""
Render de paneo 360 desde GLB — motor Workbench (CPU, headless)
Uso: python3 render_turntable.py <modelo.glb> <carpeta_frames> <num_frames>
"""
import bpy, sys, math, os

glb_path, out_dir, n_frames = sys.argv[-3], sys.argv[-2], int(sys.argv[-1])
os.makedirs(out_dir, exist_ok=True)

# Escena limpia
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Importar GLB
bpy.ops.import_scene.gltf(filepath=glb_path)

# Agrupar todo lo importado y centrarlo
objs = [o for o in scene.objects if o.type == 'MESH']
if not objs:
    raise SystemExit('El GLB no contiene mallas')

# Bounding box global
from mathutils import Vector
mins = Vector((1e9, 1e9, 1e9)); maxs = Vector((-1e9, -1e9, -1e9))
for o in objs:
    for corner in o.bound_box:
        wc = o.matrix_world @ Vector(corner)
        mins = Vector(map(min, mins, wc)); maxs = Vector(map(max, maxs, wc))
centro = (mins + maxs) / 2
dim = max((maxs - mins).length, 0.001)

# Pivote para girar el producto (gira el objeto, cámara fija)
pivote = bpy.data.objects.new('Pivote', None)
scene.collection.objects.link(pivote)
pivote.location = centro
for o in objs:
    o.parent = pivote
    o.matrix_parent_inverse = pivote.matrix_world.inverted()

# Cámara
cam_data = bpy.data.cameras.new('Cam'); cam = bpy.data.objects.new('Cam', cam_data)
scene.collection.objects.link(cam); scene.camera = cam
dist = dim * 1.1
cam.location = (centro.x, centro.y - dist, centro.z + dim * 0.18)
# Apuntar al centro
direc = centro - cam.location
cam.rotation_euler = direc.to_track_quat('-Z', 'Y').to_euler()

# Render Workbench con estudio
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.color_type = 'TEXTURE'
sh.show_specular_highlight = True
scene.display.render_aa = '8'
scene.render.resolution_x = 1080
scene.render.resolution_y = 1080
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new('W')
scene.world.color = (0.94, 0.94, 0.94)
scene.render.image_settings.file_format = 'PNG'

# Animación: giro completo del pivote
scene.frame_start = 1
scene.frame_end = n_frames
pivote.rotation_euler = (0, 0, 0)
pivote.keyframe_insert('rotation_euler', frame=1)
pivote.rotation_euler = (0, 0, math.radians(360))
pivote.keyframe_insert('rotation_euler', frame=n_frames + 1)
for fc in pivote.animation_data.action.fcurves:
    for kp in fc.keyframe_points:
        kp.interpolation = 'LINEAR'

scene.render.filepath = os.path.join(out_dir, 'f_')
bpy.ops.render.render(animation=True)
print('RENDER_OK', n_frames, 'frames en', out_dir)
