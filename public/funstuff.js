var Ƞ\u0050 = "f";
var Ƞ\u0051 = "u";
var Ƞ\u0052 = "n";
var Ƞ\u0053 = " ";
var Ƞ\u0054 = "s";
var Ƞ\u0055 = "t";
var Ƞ\u0056 = "u";
var Ƞ\u0057 = "f";
var Ƞ\u0058 = "f";


/* "Line packing" by Lionel Radisson  */
/*     http://codepen.io/MAKIO135/    */
var canvas, context, w, h, margin, play, lines;

var Vec = function (x, y) {
    this.x = x;
    this.y = y;
};

var Line = function (x1, y1, x2, y2) {
    this.a = new Vec(x1, y1);
    this.b = new Vec(x2, y2);
    this.center = new Vec((x1 + x2) / 2, (y1 + y2) / 2);
    this.dx = x2 - x1;
    this.dy = y2 - y1;
};

Line.prototype.display = function () {
    context.strokeStyle = '#FB3550';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(this.a.x, this.a.y);
    context.lineTo(this.b.x, this.b.y);
    context.stroke();
};

function sqDist(v1, v2) {
    return (v2.x - v1.x) * (v2.x - v1.x) + (v2.y - v1.y) * (v2.y - v1.y);
}

function segIntersection(l1, l2) {
    var b_dot_d_perp = l1.dx * l2.dy - l1.dy * l2.dx;
    if (b_dot_d_perp === 0) {
        return null;
    }

    var cx = l2.a.x - l1.a.x;
    var cy = l2.a.y - l1.a.y;

    var t = (cx * l2.dy - cy * l2.dx) / b_dot_d_perp;
    if (t < 0 || t > 1) {
        return null;
    }
    var u = (cx * l1.dy - cy * l1.dx) / b_dot_d_perp;
    if (u < 0 || u > 1) {
        return null;
    }
    return new Vec(Math.round(l1.a.x + t * l1.dx), Math.round(l1.a.y + t * l1.dy));
}

function getIntersections(line) {
    var arr = [];
    for (var i = 0; i < lines.length; i++) {
        var pt = segIntersection(line, lines[i]);
        if (pt !== null) {
            arr.push(pt);
        }
    }

    arr.sort(function (a, b) {
        var aIsInsideCanvas = a.x >= margin && a.x <= w - margin && a.y >= margin && a.y <= h - margin;
        var bIsInsideCanvas = b.x >= margin && b.x <= w - margin && b.y >= margin && b.y <= h - margin;
        if (aIsInsideCanvas && bIsInsideCanvas) return sqDist(a, line.center) < sqDist(b, line.center) ? 1 : -1;
        else if (aIsInsideCanvas) return 1;
        else if (bIsInsideCanvas) return -1;
        else return 0;
    });

    return arr;
}

function getNearestIntersections(line, arr) {
    let index = arr.length - 2;
    if (arr[index].x !== line.center.x) {
        while (Math.sign(line.center.x - line.a.x) === Math.sign(line.center.x - arr[index].x)) {
            if (index === 0) { return false }
            index--;
        }
    } else {
        while (Math.sign(line.center.y - line.a.y) === Math.sign(line.center.y - arr[index].y)) {
            if (index === 0) { return false }
            index--;
        }
    }

    return [arr[arr.length - 1], arr[index]];
}

function reduceLine(line, intersections) {
    line.a = intersections[0];
    line.b = intersections[1];
    line.center.x = (line.a.x - line.b.x) / 2;
    line.center.y = (line.a.y - line.b.y) / 2;
    line.dx = line.b.x - line.a.x;
    line.dy = line.b.y - line.a.y;
}

function applyRule(line) {
    var intersections = getIntersections(line);
    if (intersections.length > 2) {
        intersections = getNearestIntersections(line, intersections);
        if (intersections) {
            reduceLine(line, intersections);
        }
    }
    return true;
}

function createLine() {
    var pos = new Vec(margin + Math.random() * (w - 2 * margin), margin + Math.random() * (h - 2 * margin));
    var angle = Math.random() * Math.PI;

    var rad = 500;

    return new Line(
        pos.x + Math.cos(angle) * rad, pos.y + Math.sin(angle) * rad,
        pos.x + Math.cos(angle + Math.PI) * rad, pos.y + Math.sin(angle + Math.PI) * rad
    );
}

function addNewLine(x1, y1, x2, y2) {
    if (arguments.length === 0) {
        var line = createLine();
        if (applyRule(line)) {
            line.display();
            lines.push(line);
        }
    } else {
        lines.push(new Line(x1, y1, x2, y2));
    }
    if (lines.length >= 500) { play = false }
}

function init_funstuff() {
    canvas = document.querySelector('.background-funstuff')
    context = canvas.getContext('2d')
    margin = 0

    canvas.style.backgroundColor = '#1E2630'

    w = canvas.width = window.innerWidth;
    h = canvas.height = Math.max((document.height !== undefined) ? document.height : document.body.offsetHeight, window.innerHeight);

    play = true;

    lines = [];

    addNewLine(margin, margin, w - margin, margin);
    addNewLine(margin, h - margin, w - margin, h - margin);
    addNewLine(margin, margin, margin, h - margin);
    addNewLine(w - margin, margin, w - margin, h - margin);

    draw();
}

function toggleAnim() {
    play = !play;
    if (play) draw();
}

function draw() {
    if (play) window.requestAnimationFrame(draw);
    addNewLine();
}

window.addEventListener('DOMContentLoaded', init_funstuff)
window.addEventListener('resize', init_funstuff);
window.addEventListener('click', toggleAnim);