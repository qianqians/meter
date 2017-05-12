# -*- coding: utf-8 -*-
import sys
sys.path.append('./xlrd/')
import os
import xlrd

def excel_meter(xlr, outdir):
    if not os.path.isdir(outdir):
        os.mkdir(outdir)

    data = xlrd.open_workbook(xlr)
    tables = data.sheets()

    for i in xrange(len(tables)):
        file_name = tables[i].name

        meta_name = tables[i].name
        elem = []
        for n in xrange(tables[i].ncols):
            elem.append((tables[i].cell(0,n).value, tables[i].cell(1,n).value))

        table_name = tables[i].name + 's'

        code = "/*this caller file is codegen by meter for c#*/\n"
        code += "using System;\n"
        code += "using System.Collections;\n\n"

        code += "namespace meter\n"
        code += "{\n"
        code += "   public class " + meta_name + "\n"
        code += "   {\n"
        for k, v in elem:
            code += "       public " + v + " " + k + ";\n"
        code += "\n       public " + meta_name + "("
        for j in xrange(len(elem)):
            k,v = elem[j]
            if j < (len(elem) - 1):
                code += " " + v + " _" + k + ","
            else:
                code += " " + v + " _" + k + " "
        code += ")\n"
        code += "       {\n"
        for k, v in elem:
            code += "           " + k + " = _" + k + ";\n"
        code += "       }\n"
        code += "   }\n\n"
        code += "   public class " + table_name + "\n"
        code += "   {\n"
        code += "       public List<" + meta_name + "> " + table_name + ";\n\n"
        code += "       public " + table_name + "()\n"
        code += "       {\n"
        code += "           " + table_name + " = new List<" + meta_name + ">{\n"
        for n in xrange(2, tables[i].nrows):
            code += "               new " + meta_name + "("
            for m in xrange(tables[i].ncols):
                if m < (tables[i].ncols - 1):
                    code += " " + str(tables[i].cell(n,m).value) + ","
                else:
                    code += " " + str(tables[i].cell(n,m).value) + " "
            if n < (tables[i].nrows - 1):
                code += "),\n"
            else:
                code += ")\n"
        code += "           };\n"
        code += "       }\n"
        code += "   }\n"
        code += "}\n"

        file = open(outdir + '//' + file_name + '.cs', 'w')
        file.write(code)
        file.close

if __name__=="__main__":
    excel_meter(sys.argv[1], sys.argv[2])
