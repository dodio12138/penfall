import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tools'))
try:
    import numpy as np
    from skimage.morphology import skeletonize
    import skeleton_font
except ImportError:  # tool dependencies are optional for the server
    skeleton_font = None


@unittest.skipIf(skeleton_font is None, 'tools/requirements.txt not installed')
class SkeletonTests(unittest.TestCase):
    def test_cross_becomes_two_strokes(self):
        ink = np.zeros((120, 120), bool)
        ink[57:63, 10:110] = True   # horizontal bar
        ink[10:110, 57:63] = True   # vertical bar
        edges = skeleton_font.trace(skeletonize(ink))
        edges = skeleton_font.merge_through(edges, 180)
        edges = skeleton_font.prune(edges, 15)
        edges = skeleton_font.contract(edges, 13)
        edges = skeleton_font.merge_through(edges, 38)
        self.assertEqual(len(edges), 2)
        strokes = skeleton_font.orient_and_order([skeleton_font.simplify(e, .9) for e in edges])
        horizontal = [s for s in strokes if abs(s[0][0] - s[-1][0]) < 5][0]
        self.assertLess(horizontal[0][1], horizontal[-1][1])  # written left → right

    def test_simplify_and_dot(self):
        self.assertEqual(skeleton_font.simplify([(0, 0), (0, 1), (0, 2), (0, 10)], .5), [(0, 0), (0, 10)])
        dot = np.zeros((20, 20), bool); dot[10, 10] = True
        self.assertEqual(skeleton_font.trace(dot), [[(10, 10)]])


if __name__ == '__main__':
    unittest.main()
